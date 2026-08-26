import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { SymbolIndex } from '../index/symbolIndex';

/**
 * 「调用按钮时好时坏」诊断环③(#性能,0.3.45):索引风暴的事件循环占用。
 *
 * 用户症状:打开 proto 文件后按钮延迟出现、期间点击无反应、逐块恢复——
 * 与扩展宿主被长同步任务反复卡住的特征吻合。本环生成中等规模语料
 * (300 文件 × ~70 行),采样 SymbolIndex.build() 期间的 setImmediate 间隔:
 * 间隔 ≈ 最长连续同步执行块,直接映射「点击无响应窗口」的上限。
 *
 * 红 = 单次同步块 > 80ms 或总耗时 > 5s(UI 可感知卡顿阈值)。
 */

const FILES = 300;
const BLOCK_THRESHOLD_MS = 80;
const TOTAL_THRESHOLD_MS = 5000;

function makeCorpus(dir: string): void {
  for (let i = 0; i < FILES; i++) {
    const pkg = `corp.p${i % 20}`;
    const lines: string[] = [
      'syntax = "proto3";',
      `package ${pkg};`,
      '',
      `message Base${i} {`,
      '  string id = 1; // 标识',
      '  repeated int64 amounts = 2;',
      '}',
      '',
    ];
    // 每文件 ~70 行:几个 message + 一个 service,字段引用制造 typeRefs 体量
    for (let m = 0; m < 5; m++) {
      lines.push(
        `message M${i}_${m} {`,
        `  Base${i} base = 1;`,
        `  ${pkg}.Base${i} qualified = 2;`,
        '  map<string, string> tags = 3;',
        `  optional M${i}_${m === 0 ? 4 : m - 1} prev = 4;`,
        '}',
        '',
      );
    }
    lines.push(`service Svc${i} {`, `  rpc Get(Base${i}) returns (M${i}_0);`, `  rpc List(M${i}_1) returns (M${i}_2);`, '}', '');
    fs.writeFileSync(path.join(dir, `f${i}.proto`), lines.join('\n'));
  }
}

async function sampleEventLoopDuring<T>(fn: () => Promise<T>): Promise<{ result: T; totalMs: number; maxGapMs: number; p95GapMs: number }> {
  const gaps: number[] = [];
  let prev = Date.now();
  let running = true;
  const loop = (): void => {
    if (!running) return;
    const now = Date.now();
    gaps.push(now - prev);
    prev = now;
    setImmediate(loop);
  };
  setImmediate(loop);
  const t0 = Date.now();
  const result = await fn();
  const totalMs = Date.now() - t0;
  running = false;
  await new Promise<void>((r) => setImmediate(r));
  const sorted = [...gaps].sort((a, b) => a - b);
  const p95GapMs = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  return { result, totalMs, maxGapMs: gaps.reduce((m, g) => (g > m ? g : m), 0), p95GapMs };
}

test('SymbolIndex.build 不长阻塞事件循环(点击无响应窗口上限)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-perf-'));
  makeCorpus(dir);
  process.env.PROTO_UTILS_STUB_ROOT = dir;

  const index = new SymbolIndex();
  const { totalMs, maxGapMs, p95GapMs } = await sampleEventLoopDuring(() => index.build());

  assert.ok(
    maxGapMs <= BLOCK_THRESHOLD_MS,
    `最长同步块 ${maxGapMs}ms > ${BLOCK_THRESHOLD_MS}ms:此窗口内点击/悬停必然无响应(total=${totalMs}ms, p95=${p95GapMs}ms)`,
  );
  assert.ok(totalMs <= TOTAL_THRESHOLD_MS, `build 总耗时 ${totalMs}ms 超过 ${TOTAL_THRESHOLD_MS}ms`);
});

// ---- 诊断触发器暖路径(0.3.45 根因修复的哨兵)----
// 此前 onLoadSettled → trigger → frontend.invalidate() + load():每次打开工作台
// 都强制全量重解析,扩展宿主被长同步块占死,编辑器 CodeLens 请求饿死
// (按钮消失/无 hover/点击无响应,数分钟后风暴结束才恢复)。
// 修复后:触发器不再盲失效,frontend 靠 mtime 指纹门跳过未变更树。

test('诊断触发器:文件未变时 settle 毫秒级,不得全量重析', async () => {
  const { createLoadDiagnosticsTrigger } = await import('../loadDiagnostics');
  const { ProtoFrontend } = await import('../runtime/protoFrontend');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-warm-'));
  makeCorpus(dir); // 复用上方 300 文件语料生成器
  const frontend = new ProtoFrontend([dir]);
  frontend.load(); // 首建(本测试不计其成本)

  const fakeDiagnostics = {
    set: () => undefined,
    clear: () => undefined,
    delete: () => undefined,
    get: () => [],
    forEach: () => undefined,
  } as never;
  const trigger = createLoadDiagnosticsTrigger(fakeDiagnostics, frontend, 10);

  const gaps: number[] = [];
  let prev = Date.now();
  let running = true;
  const loop = (): void => {
    if (!running) return;
    const now = Date.now();
    gaps.push(now - prev);
    prev = now;
    setImmediate(loop);
  };
  setImmediate(loop);

  trigger.trigger();
  await new Promise<void>((r) => setTimeout(r, 400));
  running = false;
  await new Promise<void>((r) => setImmediate(r));

  const maxGapMs = gaps.reduce((m, g) => (g > m ? g : m), 0);
  assert.ok(
    maxGapMs <= 250,
    `未变更树的 settle 出现 ${maxGapMs}ms 同步块:触发器仍在全量重析(invalidate+load)`,
  );
});
