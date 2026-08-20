import * as vscode from 'vscode';
import { SymbolIndex } from '../index/symbolIndex';
import { SymbolEntry } from '../index/symbols';
import { readProtoFile } from '../runtime/protoEncoding';
import { SCALAR_TYPES, positionInRange, toVsCodeRange } from './definition';

/**
 * Hover 提供者:在类型引用与本文件定义点上显示「**kind** `qualifiedName`」,
 * 后附定义处前导注释(// 行与 /* *​/ 块)。标量类型与 definition.ts 同一口径:不响应。
 */

/** 组装 hover 内容:**kind** + `qualifiedName`(行内码),有前导注释则附在后 */
export function buildHoverMarkdown(symbol: SymbolEntry, comments: string[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${symbol.kind}** \`${symbol.qualifiedName}\``);
  if (comments.length > 0) {
    md.appendMarkdown('\n\n' + comments.join('\n'));
  }
  return md;
}

/**
 * 提取定义行(defLine,0-based)上方的连续前导注释:
 * `//` 行逐行上收;`/* *​/ 块向上吃到 `/*` 为止(单行块同样处理)。
 * 返回去掉标记符并 trim 后的注释行(文档顺序);遇空行/普通代码行即停。
 */
export function extractLeadingComment(text: string, defLine: number): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = defLine - 1;
  while (i >= 0) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//')) {
      out.unshift(trimmed.slice(2).trim());
      i--;
      continue;
    }
    if (trimmed.endsWith('*/')) {
      const block: string[] = [];
      while (i >= 0) {
        const t = lines[i].trim();
        block.unshift(t);
        i--;
        if (t.includes('/*')) break;
      }
      const cleaned = block
        .join('\n')
        .replace(/^\s*\/\*+/, '')
        .replace(/\*+\/\s*$/, '')
        .split('\n')
        .map((l) => l.replace(/^\*\s?/, '').trim())
        .filter((l) => l.length > 0);
      out.unshift(...cleaned);
      continue;
    }
    break;
  }
  return out.filter((l) => l.length > 0);
}

export class ProtoHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: SymbolIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
    // 与 definition/CodeLens 同一约定:先就地刷新当前文件索引(未保存修改立即可用)
    this.index.updateFromDocument(document);
    const entry = this.index.getFile(document.uri);
    if (!entry) return null;

    // 类型引用命中:复用与 definition.ts 同一次扫描的 typeRefs,resolve 取目标定义点
    const ref = entry.typeRefs.find((r) => positionInRange(r.range, position));
    if (ref) {
      if (SCALAR_TYPES.has(ref.name)) return null;
      const resolved = this.index.resolve(ref.name, document.uri);
      if (!resolved) return null;
      // 当前文件用编辑器内文本(可能未保存),跨文件从磁盘按编码读(GBK 兼容)
      const text = resolved.uri.fsPath === document.uri.fsPath
        ? document.getText()
        : readProtoFile(resolved.uri.fsPath);
      const comments = extractLeadingComment(text, resolved.symbol.range.start.line);
      return new vscode.Hover(buildHoverMarkdown(resolved.symbol, comments), toVsCodeRange(ref.range));
    }

    // 本文件定义点命中
    const symbol = entry.symbols.find((s) => positionInRange(s.range, position));
    if (!symbol) return null;
    const comments = extractLeadingComment(document.getText(), symbol.range.start.line);
    return new vscode.Hover(buildHoverMarkdown(symbol, comments), toVsCodeRange(symbol.range));
  }
}
