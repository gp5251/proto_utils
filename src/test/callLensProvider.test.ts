import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { SymbolIndex } from '../index/symbolIndex';
import { ProtoCallLensProvider } from '../providers/callLens';

/**
 * 「调用按钮时好时坏」诊断环①(0.3.45):
 * lens 生产侧不变量——对任何可索引的 proto3 文档,每个 rpc 方法必须恰好产出
 * 一个「带 command + 参数」的 lens。若某次返回空数组/无命令 lens,本环变红,
 * 症状(点击无反应、hover 无交互)即出在我们这边;恒绿则把嫌疑推向
 * VS Code 渲染层或命令执行链路(prefill 静默死端)。
 */

const ROOT = path.resolve('testdata/symbolIndex');
const USER = path.join(ROOT, 'sub', 'user.proto');

function fakeDocument(fsPath: string, text: string): vscode.TextDocument {
  return {
    uri: vscode.Uri.file(fsPath),
    languageId: 'proto3',
    getText: () => text,
  } as unknown as vscode.TextDocument;
}

test('provideCodeLenses:每个 rpc 恰好一个带 command 的 lens', async () => {
  process.env.PROTO_UTILS_STUB_ROOT = ROOT;
  const index = new SymbolIndex();
  await index.build();

  const text = fs.readFileSync(USER, 'utf8');
  const provider = new ProtoCallLensProvider(index);
  // 连续两次调用(模拟 VS Code 因 onDidChangeCodeLenses 重取)
  for (let round = 0; round < 2; round++) {
    const lenses = provider.provideCodeLenses(fakeDocument(USER, text));
    assert.ok(lenses.length > 0, `round ${round}: 不应返回空`);
    for (const lens of lenses) {
      assert.ok(lens.command, `round ${round}: lens 缺 command(${lens.range.start.line})`);
      assert.equal(lens.command!.command, 'protoUtils.callMethod');
      assert.ok(Array.isArray(lens.command!.arguments) && lens.command!.arguments.length === 1);
    }
  }
});

test('provideCodeLenses:rpc 全删后返回空(此时无按钮是预期,不是 bug)', async () => {
  process.env.PROTO_UTILS_STUB_ROOT = ROOT;
  const index = new SymbolIndex();
  await index.build();
  const noRpc = 'syntax = "proto3";\nmessage Empty { string id = 1; }\n';
  const lenses = new ProtoCallLensProvider(index).provideCodeLenses(
    fakeDocument(path.join(ROOT, 'empty.proto'), noRpc),
  );
  assert.equal(lenses.length, 0);
});
