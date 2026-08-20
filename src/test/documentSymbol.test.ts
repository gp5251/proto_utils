import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { SymbolIndex } from '../index/symbolIndex';
import { ProtoDocumentSymbolProvider } from '../providers/documentSymbol';

const SOURCE = [
  'syntax = "proto3";',
  'package a.b;',
  'message Foo {',
  '  message Inner {',
  '    int32 x = 1;',
  '  }',
  '}',
  'enum Color {',
  '  COLOR_UNSPECIFIED = 0;',
  '}',
  'service Greeter {',
  '  rpc SayHello (Foo) returns (Foo);',
  '  rpc Subscribe (Foo) returns (stream Foo);',
  '}',
].join('\n');

function fakeDocument(fsPath: string, text: string): vscode.TextDocument {
  const uri = vscode.Uri.file(fsPath);
  return { uri, getText: () => text } as unknown as vscode.TextDocument;
}

const DOC_PATH = path.resolve('testdata/documentSymbol/doc.proto');

test('returns message/enum/service in document order with mapped kinds', () => {
  // documentSymbol 只需要就地索引,无需全量 build
  const provider = new ProtoDocumentSymbolProvider(new SymbolIndex());
  const symbols = provider.provideDocumentSymbols(fakeDocument(DOC_PATH, SOURCE));
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind]),
    [
      ['Foo', vscode.SymbolKind.Struct],
      ['Inner', vscode.SymbolKind.Struct], // 嵌套类型平铺
      ['Color', vscode.SymbolKind.Enum],
      ['Greeter', vscode.SymbolKind.Interface],
    ],
  );
});

test('service symbol carries rpc methods as children', () => {
  const provider = new ProtoDocumentSymbolProvider(new SymbolIndex());
  const symbols = provider.provideDocumentSymbols(fakeDocument(DOC_PATH, SOURCE));
  const greeter = symbols.find((s) => s.name === 'Greeter');
  assert.ok(greeter);
  assert.deepEqual(
    greeter.children.map((c) => [c.name, c.kind]),
    [
      ['SayHello', vscode.SymbolKind.Method],
      ['Subscribe', vscode.SymbolKind.Method],
    ],
  );
  // range/selectionRange 同 symbol 定义点
  assert.deepEqual(greeter.children[0].range.start, { line: 11, character: 6 });
});

test('unindexable document returns empty list', () => {
  const provider = new ProtoDocumentSymbolProvider(new SymbolIndex());
  const symbols = provider.provideDocumentSymbols(fakeDocument(DOC_PATH, ''));
  assert.deepEqual(symbols, []);
});
