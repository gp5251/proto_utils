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

/** An rpc method definition point inside a service body (CodeLens 入口用) */
export interface RpcMethodPoint {
  name: string;
  range: Range;
  requestStream: boolean;
  responseStream: boolean;
}

/** A service definition point with its rpc methods */
export interface ServicePoint {
  name: string;
  range: Range;
  methods: RpcMethodPoint[];
}
