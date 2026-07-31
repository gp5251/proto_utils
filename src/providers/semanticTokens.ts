import * as vscode from 'vscode';

import { SymbolIndex } from '../index/symbolIndex';

const SCALAR_TYPES = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64',
  'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64',
  'bool', 'string', 'bytes',
]);

const TOKEN_TYPES = ['type', 'enum'];
const TOKEN_MODIFIERS: string[] = [];

const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

export class ProtoSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  constructor(private index: SymbolIndex) {}

  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
  ): vscode.SemanticTokens {
    this.index.updateFromDocument(document);
    const entry = this.index.getFile(document.uri);
    const builder = new vscode.SemanticTokensBuilder(LEGEND);

    if (!entry) return builder.build();

    const refs = entry.typeRefs;
    for (const ref of refs) {
      if (SCALAR_TYPES.has(ref.name)) continue;

      // Determine if it's an enum or message for distinct coloring
      const resolved = this.index.resolve(ref.name, document.uri);
      const tokenType = resolved?.symbol.kind === 'enum' ? 1 : 0;

      const line = ref.range.start.line;
      const char = ref.range.start.character;
      const length = ref.name.length;

      // Only emit single-line tokens (dotted names are one token from lexer)
      builder.push(line, char, length, tokenType, 0);
    }

    return builder.build();
  }
}

export { LEGEND as SEMANTIC_LEGEND };
