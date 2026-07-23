import * as vscode from 'vscode';
import { collectTypeRefs } from '../index/symbols';
import { SymbolIndex } from '../index/symbolIndex';

const SCALAR_TYPES = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64',
  'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64',
  'bool', 'string', 'bytes',
]);

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

    // Find type reference at cursor
    const refs = collectTypeRefs(entry.file);
    const ref = refs.find(r =>
      position.line >= r.range.start.line &&
      position.line <= r.range.end.line &&
      position.character >= r.range.start.character &&
      position.character <= r.range.end.character
    );

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
