import * as vscode from 'vscode';

import { MISSING_IMPORT_CODE, findImportInsertionLine } from '../analysis/missingImport';
import type { MissingImportFix } from '../analysis/missingImport';
import { scanProto } from '../index/scanner';

/**
 * 「漏 import」诊断的一键修复(0.3.43):灯泡里插入缺失的 import 语句。
 * 与检测模块的耦合只有 Diagnostic.code + missingImportFix payload(分析层产出的纯数据),
 * provider 自身零重算;插入位置按文档当前文本现算,诊断产生后用户又编辑过也不错位。
 */

/** 从诊断上窄化出 fix payload;无 payload 的诊断(别的来源同 code)忽略。 */
function fixOf(diag: vscode.Diagnostic): MissingImportFix | null {
  const holder = diag as vscode.Diagnostic & { missingImportFix?: unknown };
  const fix = holder.missingImportFix;
  if (fix && typeof fix === 'object' && typeof (fix as MissingImportFix).importPath === 'string') {
    return fix as MissingImportFix;
  }
  return null;
}

export class MissingImportCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    // 全文只取一次:幂等检查、插入点、EOL 判定共用
    const text = document.getText();
    // 幂等:以 scanner 抽取的真实 import 为准——子串匹配会被注释掉的 import 行误抑制
    const existing = new Set(scanProto(text).imports);
    const byImport = new Map<string, vscode.Diagnostic[]>();
    for (const diag of context.diagnostics) {
      if (diag.code !== MISSING_IMPORT_CODE) continue;
      const fix = fixOf(diag);
      if (!fix || existing.has(fix.importPath)) continue;
      const group = byImport.get(fix.importPath);
      if (group) group.push(diag);
      else byImport.set(fix.importPath, [diag]);
    }
    if (byImport.size === 0) return [];

    // 插入文本随文档 EOL:CRLF 文件插入 LF 行会混换行
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split('\n');
    const insertLine = findImportInsertionLine(text);
    // 锚点在末行且无尾换行时 insertLine 越界:钳到末行末尾并先补换行,避免粘连行尾内容
    const atEof = insertLine >= lines.length;
    const position = atEof
      ? new vscode.Position(lines.length - 1, lines[lines.length - 1].length)
      : new vscode.Position(insertLine, 0);
    const buildStatements = (paths: string[]): string =>
      (atEof ? eol : '') + paths.map((p) => `import "${p}";`).join(eol) + eol;

    const actions: vscode.CodeAction[] = [];
    for (const [importPath, diags] of byImport) {
      const action = new vscode.CodeAction(
        vscode.l10n.t('Add import "{0}"', importPath),
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = diags;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.insert(document.uri, position, buildStatements([importPath]));
      action.isPreferred = actions.length === 0;
      actions.push(action);
    }
    if (byImport.size > 1) {
      const all = new vscode.CodeAction(
        vscode.l10n.t('Add all missing imports'),
        vscode.CodeActionKind.QuickFix,
      );
      all.diagnostics = [...byImport.values()].flat();
      all.edit = new vscode.WorkspaceEdit();
      all.edit.insert(document.uri, position, buildStatements([...byImport.keys()]));
      actions.push(all);
    }
    return actions;
  }
}
