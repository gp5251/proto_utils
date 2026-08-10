import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as vscode from 'vscode';
import { SymbolIndex, FileEntry } from '../index/symbolIndex';

const ROOT = path.resolve('testdata/symbolIndex');
const BASE = path.join(ROOT, 'base.proto');
const SHADOW = path.join(ROOT, 'aaa_shadow.proto');
const BROKEN = path.join(ROOT, 'broken.proto');
const USER = path.join(ROOT, 'sub', 'user.proto');

// 每个测试独立索引;stub 的 findFiles 在调用时读环境变量(见 scripts/vscodeStub.ts)
async function buildIndex(root: string = ROOT): Promise<SymbolIndex> {
  process.env.PROTO_UTILS_STUB_ROOT = root;
  const index = new SymbolIndex();
  await index.build();
  return index;
}

function getEntry(index: SymbolIndex, fsPath: string): FileEntry {
  const entry = index.getFile(vscode.Uri.file(fsPath));
  assert.ok(entry, `expected index entry for ${fsPath}`);
  return entry;
}

function fakeDocument(fsPath: string, text: string): vscode.TextDocument {
  const uri = vscode.Uri.file(fsPath);
  return { uri, getText: () => text } as unknown as vscode.TextDocument;
}

test('finds definition points with exact name ranges', async () => {
  const index = await buildIndex();
  const entry = getEntry(index, BASE);

  assert.equal(entry.packageName, 'a.b');
  assert.deepEqual(entry.imports, []);

  const byQualified = new Map(entry.symbols.map(s => [s.qualifiedName, s]));
  assert.deepEqual([...byQualified.keys()].sort(), ['Color', 'Foo', 'Foo.Inner']);

  const foo = byQualified.get('Foo');
  assert.ok(foo);
  assert.equal(foo.kind, 'message');
  assert.deepEqual(foo.range, {
    start: { line: 4, character: 8 },
    end: { line: 4, character: 11 },
  });

  const inner = byQualified.get('Foo.Inner');
  assert.ok(inner);
  assert.equal(inner.name, 'Inner');
  assert.equal(inner.kind, 'message');
  assert.deepEqual(inner.range, {
    start: { line: 6, character: 10 },
    end: { line: 6, character: 15 },
  });

  const color = byQualified.get('Color');
  assert.ok(color);
  assert.equal(color.kind, 'enum');
  assert.deepEqual(color.range, {
    start: { line: 12, character: 5 },
    end: { line: 12, character: 10 },
  });
});

test('collects nested symbols, services and import paths', async () => {
  const index = await buildIndex();
  const entry = getEntry(index, USER);

  assert.equal(entry.packageName, 'c');
  assert.deepEqual(entry.imports, ['../base.proto']);

  const byQualified = new Map(entry.symbols.map(s => [s.qualifiedName, s]));
  assert.deepEqual(
    [...byQualified.keys()].sort(),
    ['Bar', 'Bar.Inner', 'Color', 'Greeter', 'Kind'],
  );
  assert.equal(byQualified.get('Bar')?.kind, 'message');
  assert.equal(byQualified.get('Bar.Inner')?.kind, 'message');
  assert.equal(byQualified.get('Color')?.kind, 'message');
  assert.equal(byQualified.get('Kind')?.kind, 'enum');
  assert.equal(byQualified.get('Greeter')?.kind, 'service');
  assert.deepEqual(byQualified.get('Greeter')?.range, {
    start: { line: 28, character: 8 },
    end: { line: 28, character: 15 },
  });
});

test('resolve tier 1: same file beats imported file', async () => {
  const index = await buildIndex();
  const from = vscode.Uri.file(USER);

  // user.proto 自己定义了 message Color,base.proto 有 enum Color —— 必须命中本文件
  const color = index.resolve('Color', from);
  assert.ok(color);
  assert.equal(color.uri.fsPath, USER);
  assert.equal(color.symbol.kind, 'message');
  assert.deepEqual(color.symbol.range, {
    start: { line: 20, character: 8 },
    end: { line: 20, character: 13 },
  });

  // 嵌套 qualifiedName 与前导点的全限定名也在同文件命中
  const inner = index.resolve('Bar.Inner', from);
  assert.ok(inner);
  assert.equal(inner.uri.fsPath, USER);
  assert.equal(inner.symbol.qualifiedName, 'Bar.Inner');

  const dotted = index.resolve('.c.Bar', from);
  assert.ok(dotted);
  assert.equal(dotted.uri.fsPath, USER);
  assert.equal(dotted.symbol.name, 'Bar');
});

test('resolve tier 2: imported file beats global package match', async () => {
  const index = await buildIndex();
  // aaa_shadow.proto 也定义了 Foo 且在目录序上先于 base.proto 入索引:
  // 若 import 档被跳过,全局档会先撞上 shadow 的 Foo
  const resolved = index.resolve('Foo', vscode.Uri.file(USER));
  assert.ok(resolved);
  assert.equal(resolved.uri.fsPath, BASE);
  assert.equal(resolved.symbol.qualifiedName, 'Foo');
});

test('resolve tier 3: global package match for non-imported files', async () => {
  const index = await buildIndex();
  const from = vscode.Uri.file(USER);

  // user.proto 没有 import aaa_shadow.proto
  const fqn = index.resolve('x.Thing', from);
  assert.ok(fqn);
  assert.equal(fqn.uri.fsPath, SHADOW);
  assert.equal(fqn.symbol.name, 'Thing');

  // 裸 qualifiedName 也能在全局档命中
  const bare = index.resolve('Thing', from);
  assert.ok(bare);
  assert.equal(bare.uri.fsPath, SHADOW);

  assert.equal(index.resolve('nope.Nothing', from), null);
});

test('updateFromDocument reflects unsaved changes', async () => {
  const index = await buildIndex();
  const modified = [
    'syntax = "proto3";',
    '',
    'package c.changed;',
    '',
    'import "../base.proto";',
    'import "../aaa_shadow.proto";',
    '',
    'message Fresh {',
    '  string v = 1;',
    '}',
    '',
  ].join('\n');

  index.updateFromDocument(fakeDocument(USER, modified));

  const entry = getEntry(index, USER);
  assert.equal(entry.packageName, 'c.changed');
  assert.deepEqual(entry.imports, ['../base.proto', '../aaa_shadow.proto']);

  // 新定义立即可解析(同文件档)
  const fresh = index.resolve('Fresh', vscode.Uri.file(USER));
  assert.ok(fresh);
  assert.equal(fresh.uri.fsPath, USER);
  assert.deepEqual(fresh.symbol.range, {
    start: { line: 7, character: 8 },
    end: { line: 7, character: 13 },
  });

  // 磁盘版本里的 Bar 在未保存内容中已删除
  assert.equal(index.resolve('Bar', vscode.Uri.file(USER)), null);
});

test('syntactically broken proto does not crash the index', async () => {
  // broken.proto 在语料目录里,build 必须照常完成
  const index = await buildIndex();

  // 零语义:尽量提取;条目可能存在(部分符号)但绝不能污染其它文件
  const broken = index.getFile(vscode.Uri.file(BROKEN));
  if (broken) assert.ok(Array.isArray(broken.symbols));

  const foo = index.resolve('Foo', vscode.Uri.file(USER));
  assert.ok(foo);
  assert.equal(foo.uri.fsPath, BASE);

  // 对坏文件 resolve / 重新索引纯垃圾文本都不抛
  assert.doesNotThrow(() => index.resolve('Gone', vscode.Uri.file(BROKEN)));
  assert.doesNotThrow(() =>
    index.updateFromDocument(fakeDocument(BROKEN, 'message { { { this is not proto')),
  );
  assert.doesNotThrow(() =>
    index.updateFromDocument(fakeDocument(path.join(ROOT, 'ghost.proto'), '%%% @@@ ###')),
  );
});

test('build 排除构建产物目录(out 等)的 proto 拷贝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-index-exclude-'));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  const srcFile = path.join(dir, 'a.proto');
  const outFile = path.join(dir, 'out', 'a.proto');
  fs.writeFileSync(srcFile, 'syntax = "proto3"; message A { string id = 1; }\n');
  fs.writeFileSync(outFile, 'syntax = "proto3"; message B { string id = 1; }\n');

  const index = await buildIndex(dir);
  assert.ok(index.getFile(vscode.Uri.file(srcFile)), 'src 下的 proto 应被索引');
  assert.equal(index.getFile(vscode.Uri.file(outFile)), undefined, 'out 下的拷贝不应被索引');
});

test('indexes GBK-encoded proto files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-index-gbk-'));
  // “乗”的 GBK 字节是 81 5C;按 UTF-8 误读得到 U+FFFD + 反斜杠,
  // 反斜杠转义掉收尾引号后,同行的 message 声明会被吞进字符串 token
  const gbk = Buffer.concat([
    Buffer.from('syntax = "proto3";\npackage g;\noption java_package = "com.', 'utf-8'),
    Buffer.from([0x81, 0x5c]),
    Buffer.from('"; message Foo { string name = 1; }\n', 'utf-8'),
  ]);
  const file = path.join(dir, 'gbk.proto');
  fs.writeFileSync(file, gbk);

  const index = await buildIndex(dir);
  const entry = getEntry(index, file);
  assert.equal(entry.packageName, 'g');
  assert.ok(entry.symbols.some((s) => s.qualifiedName === 'Foo'));
});
