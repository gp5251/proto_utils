import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type * as vscode from 'vscode';
import { reportLoadError } from '../loadDiagnostics';
import { ProtoFrontend } from '../runtime/protoFrontend';

/**
 * 语义错误的编辑器飘红(仿 TS):protobufjs resolveAll 抛的 "no such type" 没有位置,
 * reportLoadError 应按类型短名反查全部引用处打 Diagnostic,定位不到才退回 toast。
 */

class FakeDiagnostics {
  readonly calls = new Map<string, vscode.Diagnostic[]>();
  clear(): void {
    this.calls.clear();
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

test('定位不到引用的错误仍退回 toast 分支(不产生诊断)', () => {
  const frontend = new ProtoFrontend([FIXTURE_DIR]);
  const fake = new FakeDiagnostics();
  // 无位置、非 no-such-type 的错误:toast 分支,诊断集合保持空
  reportLoadError(fake as unknown as vscode.DiagnosticCollection, frontend, new Error('some other failure'));
  assert.equal(fake.calls.size, 0);
});
