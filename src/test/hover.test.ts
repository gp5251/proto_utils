import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import * as vscode from 'vscode';
import { FileEntry, SymbolIndex } from '../index/symbolIndex';
import { ProtoHoverProvider, extractLeadingComment } from '../providers/hover';

const ROOT = path.resolve('testdata/hover');
const MAIN = path.join(ROOT, 'main.proto');

function fakeDocument(fsPath: string, text: string): vscode.TextDocument {
  const uri = vscode.Uri.file(fsPath);
  return { uri, getText: () => text } as unknown as vscode.TextDocument;
}

// 全量索引(跨文件 resolve 走磁盘文件),provider 就地刷新 main.proto 的未保存文本
async function setup(): Promise<{
  provider: ProtoHoverProvider;
  document: vscode.TextDocument;
  entry: FileEntry;
}> {
  process.env.PROTO_UTILS_STUB_ROOT = ROOT;
  const index = new SymbolIndex();
  await index.build();
  const document = fakeDocument(MAIN, fs.readFileSync(MAIN, 'utf-8'));
  index.updateFromDocument(document);
  const entry = index.getFile(document.uri);
  assert.ok(entry, 'expected index entry for main.proto');
  return { provider: new ProtoHoverProvider(index), document, entry };
}

function hoverMarkdown(hover: vscode.Hover | null): string {
  assert.ok(hover, 'expected hover');
  const contents = hover.contents as unknown as { value: string }[];
  const first = Array.isArray(contents) ? contents[0] : contents;
  return first.value;
}

test('type ref hover: markdown carries kind, qualifiedName and leading comments (cross-file)', async () => {
  const { provider, document, entry } = await setup();
  const ref = entry.typeRefs.find((r) => r.name === 'common.User');
  assert.ok(ref, 'expected common.User type ref');

  const hover = provider.provideHover(document, ref.range.start as vscode.Position);
  const md = hoverMarkdown(hover);
  assert.ok(md.includes('**message**'), md);
  assert.ok(md.includes('`User`'), md);
  // 跨文件:注释从 common.proto 磁盘内容提取(readProtoFile)
  assert.ok(md.includes('用户模型'), md);
  assert.ok(md.includes('跨文件注释块'), md);
});

test('definition point hover: // leading comments of same-file symbol', async () => {
  const { provider, document, entry } = await setup();
  const symbol = entry.symbols.find((s) => s.qualifiedName === 'GetUserRequest');
  assert.ok(symbol);

  const hover = provider.provideHover(document, symbol.range.start as vscode.Position);
  const md = hoverMarkdown(hover);
  assert.ok(md.includes('**message** `GetUserRequest`'), md);
  assert.ok(md.includes('请求消息'), md);
  assert.ok(md.includes('第二行注释'), md);
});

test('symbol without leading comment shows only the type line', async () => {
  const { provider, document, entry } = await setup();
  const symbol = entry.symbols.find((s) => s.qualifiedName === 'GetUserResponse');
  assert.ok(symbol);

  const md = hoverMarkdown(provider.provideHover(document, symbol.range.start as vscode.Position));
  assert.equal(md, '**message** `GetUserResponse`');
});

test('scalar type ref returns no hover', async () => {
  const { provider, document, entry } = await setup();
  const ref = entry.typeRefs.find((r) => r.name === 'int32');
  assert.ok(ref, 'expected int32 type ref');
  assert.equal(provider.provideHover(document, ref.range.start as vscode.Position), null);
});

test('extractLeadingComment: single-line block and no-comment cases', () => {
  assert.deepEqual(extractLeadingComment('/* 单行块 */\nmessage A {', 1), ['单行块']);
  assert.deepEqual(extractLeadingComment('message A {', 0), []);
  // 空行打断连续性
  assert.deepEqual(extractLeadingComment('// 远处注释\n\nmessage A {', 2), []);
});
