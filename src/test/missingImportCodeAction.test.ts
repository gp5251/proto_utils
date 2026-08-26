import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MissingImportCodeActionProvider } from '../providers/missingImportCodeAction';
import { MISSING_IMPORT_CODE } from '../analysis/missingImport';
import type { MissingImportFix } from '../analysis/missingImport';

/**
 * 漏 import Quick Fix:provider 按 code 过滤诊断、读 missingImportFix payload,
 * 每个缺失 import 一条 action,≥2 个时追加聚合 action;文档已含该 import 时幂等跳过。
 */

const DOC_URI = vscode.Uri.file('/ws/protos/consumer.proto');

// 最小 TextDocument 形状:provider 只用 uri 与 getText
function fakeDocument(text: string): vscode.TextDocument {
  const doc = { uri: DOC_URI, getText: () => text };
  return doc as unknown as vscode.TextDocument;
}

function missingImportDiag(importPath: string): vscode.Diagnostic {
  const diag: vscode.Diagnostic & { missingImportFix?: MissingImportFix } = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 10),
    'missing',
    0,
  );
  diag.code = MISSING_IMPORT_CODE;
  diag.missingImportFix = { importPath };
  return diag;
}

function provide(text: string, diags: vscode.Diagnostic[]): vscode.CodeAction[] {
  // provider 只读 context.diagnostics,其余字段测试无关
  const context = { diagnostics: diags } as unknown as vscode.CodeActionContext;
  return new MissingImportCodeActionProvider().provideCodeActions(
    fakeDocument(text),
    new vscode.Range(0, 0, 0, 0),
    context,
  );
}

/** stub WorkspaceEdit 的 insert 记录(真实 vscode 无此字段)——in 窄化后读取,形状不符直接漏返空断言即红 */
function insertTexts(action: vscode.CodeAction): { line: number; text: string }[] {
  const edit = action.edit;
  if (!edit || !('inserts' in edit) || !Array.isArray(edit.inserts)) return [];
  return edit.inserts.map((i) => {
    const record = i as { position: { line: number }; text: string };
    return { line: record.position.line, text: record.text };
  });
}

const HEADER = 'syntax = "proto3";\npackage consumer.v1;\n';
const WITH_IMPORTS = HEADER + 'import "a.proto";\nimport "b.proto";\n\nmessage M {}\n';

test('单个缺失 import:一条 preferred action,插在 import 块末尾', () => {
  const diag = missingImportDiag('dep.proto');
  const actions = provide(WITH_IMPORTS, [diag]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].title, 'Add import "dep.proto"'); // stub l10n 按真实语义插值 {0}
  assert.equal(actions[0].isPreferred, true);
  assert.deepEqual(actions[0].diagnostics, [diag]);
  assert.deepEqual(insertTexts(actions[0]), [{ line: 4, text: 'import "dep.proto";\n' }]);
});

test('多个缺失 import:逐条 action + 一条聚合 action', () => {
  const d1 = missingImportDiag('dep.proto');
  const d2 = missingImportDiag('dep.proto'); // 同 importPath 多处诊断并入同一条 action
  const d3 = missingImportDiag('other.proto');
  const actions = provide(HEADER, [d1, d2, d3]);
  assert.equal(actions.length, 3);
  assert.deepEqual(actions[0].diagnostics, [d1, d2]);
  assert.deepEqual(actions[1].diagnostics, [d3]);
  // 聚合:单次插入两条语句,带全部诊断;无 import 块时插在 package 行之后
  assert.equal(actions[2].title, 'Add all missing imports');
  assert.deepEqual(actions[2].diagnostics, [d1, d2, d3]);
  assert.deepEqual(insertTexts(actions[2]), [{ line: 2, text: 'import "dep.proto";\nimport "other.proto";\n' }]);
});

test('幂等:文档已含该 import 则不再提供对应 action', () => {
  const text = WITH_IMPORTS + 'import "dep.proto";\n';
  assert.equal(provide(text, [missingImportDiag('dep.proto')]).length, 0);
});

test('注释掉的 import 不抑制 Quick Fix(以 scanner 抽取的真实 import 为准)', () => {
  const text = HEADER + '// import "dep.proto";\n\nmessage M {}\n';
  const actions = provide(text, [missingImportDiag('dep.proto')]);
  assert.equal(actions.length, 1);
  assert.deepEqual(insertTexts(actions[0]), [{ line: 2, text: 'import "dep.proto";\n' }]);
});

test('CRLF 文档插入 CRLF 行尾,不混换行', () => {
  const text = HEADER.replaceAll('\n', '\r\n');
  const actions = provide(text, [missingImportDiag('dep.proto')]);
  assert.deepEqual(insertTexts(actions[0]), [{ line: 2, text: 'import "dep.proto";\r\n' }]);
});

test('锚点在末行且无尾换行:钳到末行末尾并先补换行,不粘连', () => {
  const text = 'syntax = "proto3";\npackage consumer.v1;';
  const actions = provide(text, [missingImportDiag('dep.proto')]);
  assert.deepEqual(insertTexts(actions[0]), [{ line: 1, text: '\nimport "dep.proto";\n' }]);
});

test('无 payload 或异 code 的诊断被忽略', () => {
  const plain = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'other', 0);
  plain.code = 'unrelated';
  const noPayload = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'missing', 0);
  noPayload.code = MISSING_IMPORT_CODE;
  assert.equal(provide(HEADER, [plain, noPayload]).length, 0);
});
