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
