import * as vscode from 'vscode';
import { SymbolIndex } from '../index/symbolIndex';
import { Range } from '../index/symbols';

export const SCALAR_TYPES = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64',
  'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64',
  'bool', 'string', 'bytes',
]);

/** 位置是否落在 range 内(闭区间;hover 与 definition 共用同一包含判断) */
export function positionInRange(range: Range, position: { line: number; character: number }): boolean {
  return (
    position.line >= range.start.line &&
    position.line <= range.end.line &&
    position.character >= range.start.character &&
    position.character <= range.end.character
  );
}

/** 索引层 Range → vscode.Range;hover/documentSymbol 共用 */
export function toVsCodeRange(range: Range): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

export class ProtoDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private index: SymbolIndex) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | null {
    // Ensure current document is up-to-date in the index
    this.index.updateFromDocument(document);

    const entry = this.index.getFile(document.uri);
    if (!entry) return null;

    // 与索引同一次扫描的引用点(避免对同一文本二次 scanProto)
    const ref = entry.typeRefs.find(r => positionInRange(r.range, position));

    if (!ref) return null;
    if (SCALAR_TYPES.has(ref.name)) return null;

    // Resolve via index (same file → imports → global)
    const resolved = this.index.resolve(ref.name, document.uri);
    if (!resolved) return null;

    return new vscode.Location(
      resolved.uri,
      new vscode.Range(
        resolved.symbol.range.start.line,
        resolved.symbol.range.start.character,
        resolved.symbol.range.end.line,
        resolved.symbol.range.end.character,
      ),
    );
  }
}
