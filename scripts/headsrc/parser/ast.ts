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

/** An identifier with its source location */
export interface Ident {
  name: string;
  range: Range;
}

// ─── Top-level ───────────────────────────────────────────────

export interface ProtoFile {
  syntax: string | null;
  package: Ident | null;
  imports: ImportStatement[];
  options: OptionStatement[];
  definitions: TopLevelDef[];
  diagnostics: Diagnostic[];
}

export type TopLevelDef = MessageDef | EnumDef | ServiceDef;

export interface ImportStatement {
  path: string;
  modifier: 'weak' | 'public' | null;
  range: Range;
}

export interface OptionStatement {
  name: string;
  value: string;
  range: Range;
}

// ─── Message ─────────────────────────────────────────────────

export interface MessageDef {
  kind: 'message';
  name: Ident;
  fields: FieldDef[];
  nestedMessages: MessageDef[];
  nestedEnums: EnumDef[];
  oneofs: OneofDef[];
  options: OptionStatement[];
  reserved: ReservedDef[];
  range: Range;
}

export type FieldDef = NormalField | MapField;

export interface NormalField {
  kind: 'field';
  label: 'repeated' | null;
  type: Ident; // scalar or message/enum reference
  name: Ident;
  fieldNumber: number;
  range: Range;
}

export interface MapField {
  kind: 'map';
  keyType: Ident;
  valueType: Ident;
  name: Ident;
  fieldNumber: number;
  range: Range;
}

export interface OneofDef {
  name: Ident;
  fields: NormalField[];
  range: Range;
}

export interface ReservedDef {
  entries: (number | string)[];
  range: Range;
}

// ─── Enum ────────────────────────────────────────────────────

export interface EnumDef {
  kind: 'enum';
  name: Ident;
  values: EnumValueDef[];
  options: OptionStatement[];
  range: Range;
}

export interface EnumValueDef {
  name: Ident;
  number: number;
  range: Range;
}

// ─── Service ─────────────────────────────────────────────────

export interface ServiceDef {
  kind: 'service';
  name: Ident;
  rpcs: RpcDef[];
  options: OptionStatement[];
  range: Range;
}

export interface RpcDef {
  name: Ident;
  inputType: Ident;
  inputStream: boolean;
  outputType: Ident;
  outputStream: boolean;
  range: Range;
}

// ─── Diagnostics ─────────────────────────────────────────────

export interface Diagnostic {
  message: string;
  range: Range;
}
