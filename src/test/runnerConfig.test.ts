import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRunnerConfig } from '../runner/config';

const ROOT = path.resolve('/ws/root');

test('defaults: server localhost:50051, protoDir = workspace root', () => {
  const cfg = resolveRunnerConfig(() => undefined, ROOT);
  assert.equal(cfg.server, 'localhost:50051');
  assert.equal(cfg.protoDir, ROOT);
});

test('explicit values pass through; relative protoDir resolves against workspace root', () => {
  const values: Record<string, unknown> = { 'runner.server': '10.0.0.1:9000', 'runner.protoDir': 'protos' };
  const cfg = resolveRunnerConfig((k) => values[k], ROOT);
  assert.equal(cfg.server, '10.0.0.1:9000');
  assert.equal(cfg.protoDir, path.join(ROOT, 'protos'));
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
