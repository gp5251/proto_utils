import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type * as vscode from 'vscode';
import { reportLoadError } from '../loadDiagnostics';
import { ProtoFrontend } from '../runtime/protoFrontend';
import { scanProto } from '../index/scanner';

/**
 * 语义错误的编辑器飘红(仿 TS):protobufjs resolveAll 抛的 "no such type" 没有位置,
 * reportLoadError 应按类型短名反查全部引用处打 Diagnostic,定位不到才退回 toast。
 */

class FakeDiagnostics {
  readonly calls = new Map<string, vscode.Diagnostic[]>();
  clear(): void {
    this.calls.clear();
  }
  get(uri: vscode.Uri): vscode.Diagnostic[] | undefined {
    return this.calls.get(uri.fsPath);
  }
  set(uri: vscode.Uri, diags: vscode.Diagnostic[]): void {
    this.calls.set(uri.fsPath, diags);
  }
}

const FIXTURE_DIR = path.resolve('testdata/unresolved');

test('no such type:引用处精确飘红(file/line/col),不弹 toast', () => {
  const frontend = new ProtoFrontend([FIXTURE_DIR]);
  let err: unknown;
  try {
    frontend.load();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error && /no such type/.test(err.message), 'fixture 应触发 no such type');

  const fake = new FakeDiagnostics();
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, frontend, err);

  const file = path.join(FIXTURE_DIR, 'broken.proto');
  const diags = fake.calls.get(file);
  assert.ok(diags && diags.length === 1, 'broken.proto 应恰好 1 处诊断');
  const d = diags[0];
  assert.equal(d.severity, 0, 'Error 级(飘红)');
  // MissingRequest 位于第 7 行(0-based 6),列 = 'demo.v1.' 前缀之后
  assert.equal(d.range.start.line, 6);
  assert.equal(d.range.start.character, '  rpc Do (demo.v1.'.length);
  assert.equal(d.range.end.character, '  rpc Do (demo.v1.'.length + 'MissingRequest'.length);
});

test('多个缺失类型一次报齐(resolveAll 级联报错已修)', () => {
  const frontend = new ProtoFrontend([FIXTURE_DIR]);
  let err: unknown;
  try {
    frontend.load();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  // 合并消息应同时含两个缺失类型名
  assert.match(err.message, /MissingAlpha/);
  assert.match(err.message, /MissingBeta/);

  const fake = new FakeDiagnostics();
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, frontend, err);

  const file = path.join(FIXTURE_DIR, 'multi_bad.proto');
  const diags = fake.calls.get(file);
  assert.ok(diags && diags.length === 2, 'multi_bad.proto 应有 2 处诊断');
  assert.equal(diags[0].range.start.line, 5);
  assert.equal(diags[1].range.start.line, 6);
});

test('定位不到引用的错误仍退回 toast 分支(不产生诊断)', () => {
  const frontend = new ProtoFrontend([FIXTURE_DIR]);
  const fake = new FakeDiagnostics();
  // 无位置、非 no-such-type 的错误:toast 分支,诊断集合保持空
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, frontend, new Error('some other failure'));
  assert.equal(fake.calls.size, 0);
});

/** 收集 fixture 加载错误;无错误时 fail 掉(前置假设被打破要可见) */
function loadErrorOf(dir: string): Error {
  const frontend = new ProtoFrontend([dir]);
  try {
    frontend.load();
  } catch (e) {
    assert.ok(e instanceof Error);
    return e;
  }
  assert.fail(`${dir} 应加载失败`);
}

test("语法错:违规 token 在出错行唯一出现 → 收窄到 token", () => {
  const dir = path.resolve('testdata/syntax-token');
  const err = loadErrorOf(dir);
  // bad.proto 第 5 行孤 '}'(protobufjs 报 "illegal name '}'")
  const fake = new FakeDiagnostics();
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, new ProtoFrontend([dir]), err);
  const diags = fake.calls.get(path.join(dir, 'bad.proto'));
  assert.ok(diags && diags.length === 1);
  const r = diags[0].range;
  assert.equal(r.start.line, 4, "'}' 位于第 5 行(0-based 4)");
  assert.equal(r.start.character, 0);
  assert.equal(r.end.character, 1, '收窄到 token 宽度,不再是整行');
});

test("语法错:token 在行内多次出现 → 保持整行(无回归)", () => {
  const dir = path.resolve('testdata/syntax-token-multi');
  const err = loadErrorOf(dir);
  // dup_close.proto 第 2 行 `message Foo {} }` 含两个 '}'
  const fake = new FakeDiagnostics();
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, new ProtoFrontend([dir]), err);
  const diags = fake.calls.get(path.join(dir, 'dup_close.proto'));
  assert.ok(diags && diags.length === 1);
  assert.equal(diags[0].range.start.line, 1);
  assert.equal(diags[0].range.end.character, Number.MAX_SAFE_INTEGER, '整行回退');
});

test("Field 缺类型(引号形 no such Type or Enum)也精确飘红", () => {
  // 0.3.40 前该措辞不匹配 no such type 正则,只能退 toast
  const dir = path.resolve('testdata/unresolved-field');
  const err = loadErrorOf(dir);
  assert.match(err.message, /no such Type or Enum/);
  const fake = new FakeDiagnostics();
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, new ProtoFrontend([dir]), err);
  const diags = fake.calls.get(path.join(dir, 'field_bad.proto'));
  assert.ok(diags && diags.length === 1);
  const d = diags[0];
  // MissingField 位于第 5 行(0-based 4),列 = '  demo.v1.' 前缀之后
  assert.equal(d.range.start.line, 4);
  assert.equal(d.range.start.character, '  demo.v1.'.length);
  assert.equal(d.range.end.character, '  demo.v1.'.length + 'MissingField'.length);
});

test("duplicate name:两处声明点飘红(Namespace 按全限定 container 匹配)", () => {
  const dir = path.resolve('testdata/duplicate');
  const err = loadErrorOf(dir);
  assert.match(err.message, /duplicate name 'Foo' in Namespace \.dup/);
  const fake = new FakeDiagnostics();
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, new ProtoFrontend([dir]), err);
  assert.equal(fake.calls.size, 2, 'a.proto 与 b.proto 各一处');
  for (const name of ['a.proto', 'b.proto']) {
    const file = path.join(dir, name);
    const diags = fake.calls.get(file);
    assert.ok(diags && diags.length === 1, `${name} 恰好 1 处诊断`);
    // 与扫描器(ADR-0003)对同一文件的声明点结论一致,而非硬编码行列
    const sym = scanProto(fs.readFileSync(file, 'utf8')).symbols.find((s) => s.name === 'Foo');
    assert.ok(sym);
    assert.equal(diags[0].range.start.line, sym.range.start.line);
    assert.equal(diags[0].range.start.character, sym.range.start.character);
    assert.equal(diags[0].range.end.character, sym.range.end.character);
  }
});

test("duplicate name:Type 形(嵌套类型重名)按父短名匹配嵌套声明点", () => {
  const dir = path.resolve('testdata/duplicate-nested');
  const err = loadErrorOf(dir);
  assert.match(err.message, /duplicate name 'Foo' in Type A/);
  const fake = new FakeDiagnostics();
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, new ProtoFrontend([dir]), err);
  const file = path.join(dir, 'nested.proto');
  const diags = fake.calls.get(file);
  assert.equal(fake.calls.size, 1);
  assert.ok(diags && diags.length === 2, '两个嵌套 Foo 声明点都飘红');
  const expected = scanProto(fs.readFileSync(file, 'utf8')).symbols.filter((s) => s.name === 'Foo');
  assert.equal(expected.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(diags[i].range.start.line, expected[i].range.start.line);
    assert.equal(diags[i].range.start.character, expected[i].range.start.character);
  }
});

test("duplicate name:Enum 值重名不在 symbols 内 → 退 toast,不误伤同名 message", () => {
  const dir = path.resolve('testdata/duplicate-enum');
  const err = loadErrorOf(dir);
  assert.match(err.message, /duplicate name 'A' in Enum E/);
  const fake = new FakeDiagnostics();
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, new ProtoFrontend([dir]), err);
  assert.equal(fake.calls.size, 0, '跨种类同名 message A 不得被误标');
});
