import * as vscode from 'vscode';
import fs from 'node:fs';
import { ProtoFrontend, ProtoLoadError } from './runtime/protoFrontend';

/**
 * 保存诊断链路(ADR-0002):语法错(带 file/line)就地飘红;
 * 语义错(no such type,protobufjs resolveAll 不给位置)按类型短名反查全部引用处飘红,
 * 仿 TS 体验;定位不到引用才退回 toast。
 */

/** 上一次弹过 toast 的加载错误;相同错误不重复弹(每次保存都失败会刷屏)。 */
let lastLoadErrorToast: string | null = null;

export function reportLoadError(diagnostics: vscode.DiagnosticCollection, frontend: ProtoFrontend, err: unknown): void {
  diagnostics.clear();
  if (!(err instanceof ProtoLoadError) || !err.file) {
    const message = err instanceof Error ? err.message : String(err);
    if (reportUnresolvedTypeRefs(diagnostics, frontend, message)) {
      lastLoadErrorToast = null;
      return;
    }
    if (message === lastLoadErrorToast) return;
    lastLoadErrorToast = message;
    vscode.window.showErrorMessage(`Proto Utils: ${message}`);
    return;
  }
  const line = Math.max(0, (err.line ?? 1) - 1);
  const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
  const diagnostic = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
  diagnostics.set(vscode.Uri.file(err.file), [diagnostic]);
}

/** 加载成功后由保存处理器调用:清空诊断并重置 toast 去重。 */
export function clearLoadErrorState(diagnostics: vscode.DiagnosticCollection): void {
  diagnostics.clear();
  lastLoadErrorToast = null;
}

/** 匹配 protobufjs resolve 的 "no such type/name: <as-written>"(全局:合并消息一次含多条)。 */
const NO_SUCH_TYPE_RE = /\bno such (?:type|name):\s*([\w.]+)/g;

function reportUnresolvedTypeRefs(
  diagnostics: vscode.DiagnosticCollection,
  frontend: ProtoFrontend,
  message: string,
): boolean {
  const shortNames = new Set<string>();
  for (const m of message.matchAll(NO_SUCH_TYPE_RE)) {
    shortNames.add(m[1].slice(m[1].lastIndexOf('.') + 1));
  }
  if (shortNames.size === 0) return false;
  let found = false;
  for (const shortName of shortNames) {
    const refRe = new RegExp(`\\b${shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    for (const file of frontend.scan()) {
      const text = fs.readFileSync(file, 'utf8');
      const lineStarts: number[] = [0];
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
      }
      const diags = [...(diagnostics.get?.(vscode.Uri.file(file)) ?? [])];
      refRe.lastIndex = 0;
      let hit: RegExpExecArray | null;
      while ((hit = refRe.exec(text))) {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (lineStarts[mid] <= hit.index) lo = mid;
          else hi = mid - 1;
        }
        const col = hit.index - lineStarts[lo];
        const range = new vscode.Range(lo, col, lo, col + shortName.length);
        diags.push(new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error));
      }
      if (diags.length > 0) {
        diagnostics.set(vscode.Uri.file(file), diags);
        found = true;
      }
    }
  }
  return found;
}
