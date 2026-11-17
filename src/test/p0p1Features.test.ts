import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrpcurlCommand, shellQuote } from '../runner/utils/grpcurl';
import { CallHistory, type HistoryEntry, type HistoryState } from '../runner/history';
import { Environments } from '../runner/environments';
import type { SequenceStoreFs } from '../runner/sequenceStore';
import { evaluateAssertions } from '../runner/assertions';

class MemoryState implements HistoryState {
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

const historyEntry = (ts: number, values: Record<string, unknown> = { id: 1 }): HistoryEntry => ({
  service: 'pkg.User', method: 'Get', values, metadata: [{ key: 'authorization', value: '{{token}}' }],
  ts, ok: true, durationMs: 12,
});

test('grpcurl:拼入 proto、metadata、JSON、超时并做 POSIX 单引号转义', () => {
  const command = buildGrpcurlCommand({
    server: 'localhost:50051', serviceFullName: 'pkg.User', method: 'Get', request: { name: "O'Reilly" },
    metadata: [{ key: 'authorization', value: 'Bearer abc' }],
    tls: { enabled: false, rootCert: null, clientCert: null, clientKey: null },
    timeoutMs: 1500, protoDir: '/tmp/my protos', protoFile: 'user.proto',
  });
  assert.match(command, /grpcurl \\\n  -plaintext/);
  assert.match(command, /-import-path '\/tmp\/my protos'/);
  assert.match(command, /-H 'authorization: Bearer abc'/);
  assert.match(command, /-max-time 1\.5/);
  assert.match(command, /pkg\.User\/Get/);
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('请求历史:最新在前，相同请求只刷新头项', async () => {
  const state = new MemoryState();
  const history = new CallHistory(state);
  assert.deepEqual(await history.add(historyEntry(1)), [historyEntry(1)]);
  assert.deepEqual(await history.add(historyEntry(2)), [historyEntry(2)], '相同请求不重复堆积');
  const next = await history.add(historyEntry(3, { id: 2 }));
  assert.deepEqual(next.map((e) => e.ts), [3, 2]);
  assert.deepEqual(new CallHistory(state).list(), next, '通过 workspaceState 替身持久化');
});

test('环境文件:读取、切换并把标量变量统一转为字符串', async () => {
  const state = new MemoryState();
  const files = new Map<string, string>();
  const fs: SequenceStoreFs = {
    readFile: async (file) => {
      const value = files.get(file);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    writeFile: async (file, data) => { files.set(file, data); },
    mkdir: async () => undefined,
    rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
  };
  const envs = new Environments('/workspace', state, fs);
  files.set(envs.filePath, JSON.stringify({ dev: { host: 'localhost:50051', retries: 2, secure: true, skip: null } }));
  await envs.reload();
  await envs.setActive('dev');
  assert.deepEqual(envs.snapshot(), {
    names: ['dev'], active: 'dev', variables: { host: 'localhost:50051', retries: '2', secure: 'true' },
  });
});

test('步骤断言:eq/contains/exists/数值比较支持环境变量与前序输出', () => {
  const results = evaluateAssertions(
    [
      { path: 'data.id', op: 'eq', expected: '{{wanted}}' },
      { path: 'data.tags', op: 'contains', expected: 'beta' },
      { path: 'data.name', op: 'exists' },
      { path: 'durationMs', op: 'lt', expected: '{{step0.data.limit}}' },
    ],
    { data: { id: 7, tags: ['alpha', 'beta'], name: 'n' } },
    9,
    { 0: { data: { limit: 10 } } },
    1,
    { wanted: '7' },
  );
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true]);
});

test('contains 断言(0.3.91):整值占位符对象期望值按 JSON 序列化匹配,不再恒假', () => {
  // 审计 H8:String(exp) 对对象得 "[object Object]",contains 必假 → 序列误中止。
  const results = evaluateAssertions(
    [{ path: 'data.obj', op: 'contains', expected: '{{step0.data.obj}}' }],
    { data: { obj: { a: 1 } } },
    1,
    { 0: { data: { obj: { a: 1 } } } },
    1,
    {},
  );
  assert.deepEqual(results.map((r) => r.ok), [true]);
});

test('environments reload 并发(0.3.91):迟到的旧读不得覆盖新内容', async () => {
  // 审计 H7:reload 先清空再 await 读,无版本守卫;旧读后到即覆新。
  const state = new MemoryState();
  const files = new Map<string, string>();
  let call = 0;
  const fs: SequenceStoreFs = {
    readFile: async (f) => {
      const snap = files.get(f);
      if (snap === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const delay = call++ === 0 ? 30 : 0;
      await new Promise((r) => setTimeout(r, delay));
      return snap;
    },
    writeFile: async (f, d) => { files.set(f, d); },
    mkdir: async () => undefined,
    rename: async (f, t) => { files.set(t, files.get(f)!); files.delete(f); },
  };
  const envs = new Environments('/workspace', state, fs);
  files.set(envs.filePath, JSON.stringify({ dev: { host: 'old' } }));
  const r1 = envs.reload();
  files.set(envs.filePath, JSON.stringify({ dev: { host: 'new' } }));
  const r2 = envs.reload();
  await Promise.all([r1, r2]);
  await envs.setActive('dev');
  assert.equal(envs.snapshot().variables.host, 'new', '最终态必须是最后一次 reload 的内容');
});
