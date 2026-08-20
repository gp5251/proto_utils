import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRunnerConfig, resolveScanExcludes, isDirExcluded } from '../runner/config';

const ROOT = path.resolve('/ws/root');

test('defaults: server localhost:50051, protoDir = workspace root', () => {
  const cfg = resolveRunnerConfig(() => undefined, ROOT);
  assert.equal(cfg.server, 'localhost:50051');
  assert.equal(cfg.protoDir, ROOT);
  assert.equal(cfg.protoDirExplicit, false);
});

test('explicit values pass through; relative protoDir resolves against workspace root', () => {
  const values: Record<string, unknown> = { 'runner.server': '10.0.0.1:9000', 'runner.protoDir': 'protos' };
  const cfg = resolveRunnerConfig((k) => values[k], ROOT);
  assert.equal(cfg.server, '10.0.0.1:9000');
  assert.equal(cfg.protoDir, path.join(ROOT, 'protos'));
  assert.equal(cfg.protoDirExplicit, true);
});

test('absolute protoDir is used as-is', () => {
  const abs = path.resolve('/elsewhere/protos');
  const cfg = resolveRunnerConfig((k) => (k === 'runner.protoDir' ? abs : undefined), ROOT);
  assert.equal(cfg.protoDir, abs);
});

test('garbage values fall back to defaults', () => {
  const values: Record<string, unknown> = { 'runner.server': 42, 'runner.protoDir': ['x'] };
  const cfg = resolveRunnerConfig((k) => values[k], ROOT);
  assert.equal(cfg.server, 'localhost:50051');
  assert.equal(cfg.protoDir, ROOT);
});

test('no workspace folder and no protoDir configured → protoDir null', () => {
  const cfg = resolveRunnerConfig(() => undefined, undefined);
  assert.equal(cfg.protoDir, null);
});

test('tls 默认关闭;证书路径空串 → null,相对路径相对 workspace 根 join,绝对路径原样规范化', () => {
  const cfg = resolveRunnerConfig(() => undefined, ROOT);
  assert.deepEqual(cfg.tls, { enabled: false, rootCert: null, clientCert: null, clientKey: null });

  const values: Record<string, unknown> = {
    'runner.tls': true,
    'runner.tlsRootCert': 'certs/ca.pem',
    'runner.tlsClientCert': path.resolve('/abs/client.pem'),
    'runner.tlsClientKey': '  ',
  };
  const cfg2 = resolveRunnerConfig((k) => values[k], ROOT);
  assert.equal(cfg2.tls.enabled, true);
  assert.equal(cfg2.tls.rootCert, path.join(ROOT, 'certs/ca.pem'));
  assert.equal(cfg2.tls.clientCert, path.normalize(path.resolve('/abs/client.pem')));
  assert.equal(cfg2.tls.clientKey, null);
});

test('metadata 解析:首个冒号切开、两端 trim;无冒号/空 key/非字符串行跳过', () => {
  const values: Record<string, unknown> = {
    'runner.metadata': ['authorization: Bearer abc', 'x-env:prod', 'no-colon-line', ': orphan', 42, 'x-a: b: c'],
  };
  const cfg = resolveRunnerConfig((k) => values[k], ROOT);
  assert.deepEqual(cfg.metadata, [
    { key: 'authorization', value: 'Bearer abc' },
    { key: 'x-env', value: 'prod' },
    { key: 'x-a', value: 'b: c' },
  ]);

  // 非数组 → 空
  assert.deepEqual(resolveRunnerConfig((k) => (k === 'runner.metadata' ? 'oops' : undefined), ROOT).metadata, []);
});

test('timeoutMs 兜底:非有限数/负数/非 number → 15000;0 合法(不限)', () => {
  assert.equal(resolveRunnerConfig(() => undefined, ROOT).timeoutMs, 15000);
  const at = (v: unknown) => resolveRunnerConfig((k) => (k === 'runner.timeoutMs' ? v : undefined), ROOT).timeoutMs;
  assert.equal(at(-1), 15000);
  assert.equal(at(Number.NaN), 15000);
  assert.equal(at('3000'), 15000);
  assert.equal(at(0), 0);
  assert.equal(at(3000), 3000);
});

test('scan.excludeDirs:裸名进 names,相对/绝对路径进 paths(规范化)', () => {
  const abs = path.resolve('/elsewhere/protos');
  const ex = resolveScanExcludes(
    (k) => (k === 'scan.excludeDirs' ? ['out-vscode', 'src/third_party/protos', abs, '  ', 42] : undefined),
    ROOT,
  );
  const nameKey = process.platform === 'win32' ? 'out-vscode' : 'out-vscode';
  assert.ok(ex.names.has(nameKey));
  assert.equal(ex.paths.length, 2);
  assert.ok(isDirExcluded('out-vscode', path.join(ROOT, 'out-vscode'), ex));
  assert.ok(isDirExcluded('protos', path.join(ROOT, 'src', 'third_party', 'protos'), ex));
  assert.ok(isDirExcluded('deep', path.join(ROOT, 'src', 'third_party', 'protos', 'deep'), ex));
  assert.ok(isDirExcluded('protos', abs, ex));
  assert.ok(!isDirExcluded('common', path.join(ROOT, 'src', 'common'), ex));
});

test('scan.excludeDirs:非数组/空配置 → 空排除集', () => {
  assert.equal(resolveScanExcludes(() => undefined, ROOT).names.size, 0);
  assert.equal(resolveScanExcludes((k) => (k === 'scan.excludeDirs' ? 'out' : undefined), ROOT).paths.length, 0);
});
