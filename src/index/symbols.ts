/** Position in source text (0-based line and character) */
export interface Position {
  line: number;
  character: number;
}

/** A range in source text */
export interface Range {
  start: Position;
  end: Position;
}

/**
 * A definition point found by the zero-semantics scanner (ADR-0003):
 * just a name and where it is declared. No type resolution, no validation.
 */
export interface SymbolEntry {
  name: string;
  qualifiedName: string;
  range: Range;
  kind: 'message' | 'enum' | 'service';
}

/** A type reference position in a file (for semantic tokens / navigation) */
export interface TypeRef {
  name: string;
  range: Range;
}
