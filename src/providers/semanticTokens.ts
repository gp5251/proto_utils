import * as vscode from 'vscode';

import { SymbolIndex } from '../index/symbolIndex';
import { SCALAR_TYPES } from './definition';

const TOKEN_TYPES = ['type', 'enum'];
const TOKEN_MODIFIERS: string[] = [];

const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

/**
 * 引用名 → token 类型(0=type,1=enum)。resolveKind 每个唯一名字只调用一次:
 * 大文件里同一 message 被引用几十次很常见,而 resolve 的全局档是
 * O(entries×symbols)——按次去重是高频击键下的主要收益(#12 性能,0.3.44)。
 */
export function tokenTypesForRefs(
  names: readonly string[],
  resolveKind: (name: string) => 'enum' | 'other',
): number[] {
  const cache = new Map<string, number>();
  return names.map((name) => {
    let kind = cache.get(name);
    if (kind === undefined) {
      kind = resolveKind(name) === 'enum' ? 1 : 0;
      cache.set(name, kind);
    }
    return kind;
  });
}

export class ProtoSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  constructor(private index: SymbolIndex) {}

  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
  ): vscode.SemanticTokens {
    this.index.updateFromDocument(document);
    const entry = this.index.getFile(document.uri);
    const builder = new vscode.SemanticTokensBuilder(LEGEND);

    if (!entry) return builder.build();

    // 标量不产 token;其余引用分类走 memo(resolve 唯一名一次)
    const refs = entry.typeRefs.filter((r) => !SCALAR_TYPES.has(r.name));
    const kinds = tokenTypesForRefs(
      refs.map((r) => r.name),
      (name) => (this.index.resolve(name, document.uri)?.symbol.kind === 'enum' ? 'enum' : 'other'),
    );
    refs.forEach((ref, i) => {
      // Only emit single-line tokens (dotted names are one token from lexer)
      builder.push(ref.range.start.line, ref.range.start.character, ref.name.length, kinds[i], 0);
    });

    return builder.build();
  }
}

export { LEGEND as SEMANTIC_LEGEND };
