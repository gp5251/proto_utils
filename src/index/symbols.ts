import * as ast from '../parser/ast';

export interface SymbolEntry {
  name: string;
  qualifiedName: string;
  range: ast.Range;
  kind: 'message' | 'enum' | 'service';
}

/** Collect all type definitions (messages, enums, services) including nested ones */
export function collectDefinitions(file: ast.ProtoFile): SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  const pkg = file.package?.name ?? '';

  function walkMessage(msg: ast.MessageDef, prefix: string): void {
    const qualified = prefix ? `${prefix}.${msg.name.name}` : msg.name.name;
    entries.push({ name: msg.name.name, qualifiedName: qualified, range: msg.name.range, kind: 'message' });
    for (const nested of msg.nestedMessages) walkMessage(nested, qualified);
    for (const nested of msg.nestedEnums) walkEnum(nested, qualified);
  }

  function walkEnum(e: ast.EnumDef, prefix: string): void {
    const qualified = prefix ? `${prefix}.${e.name.name}` : e.name.name;
    entries.push({ name: e.name.name, qualifiedName: qualified, range: e.name.range, kind: 'enum' });
  }

  for (const def of file.definitions) {
    if (def.kind === 'message') walkMessage(def, '');
    else if (def.kind === 'enum') walkEnum(def, '');
    else if (def.kind === 'service') {
      entries.push({ name: def.name.name, qualifiedName: def.name.name, range: def.name.range, kind: 'service' });
    }
  }

  return entries;
}

/** All type reference positions in a file (for semantic tokens / navigation) */
export interface TypeRef {
  name: string;
  range: ast.Range;
}

export function collectTypeRefs(file: ast.ProtoFile): TypeRef[] {
  const refs: TypeRef[] = [];

  function walkFields(fields: ast.FieldDef[]): void {
    for (const f of fields) {
      if (f.kind === 'field') {
        refs.push({ name: f.type.name, range: f.type.range });
      } else {
        refs.push({ name: f.valueType.name, range: f.valueType.range });
      }
    }
  }

  function walkMessage(msg: ast.MessageDef): void {
    walkFields(msg.fields);
    for (const oneof of msg.oneofs) {
      for (const f of oneof.fields) {
        refs.push({ name: f.type.name, range: f.type.range });
      }
    }
    for (const nested of msg.nestedMessages) walkMessage(nested);
  }

  for (const def of file.definitions) {
    if (def.kind === 'message') walkMessage(def);
    else if (def.kind === 'service') {
      for (const rpc of def.rpcs) {
        refs.push({ name: rpc.inputType.name, range: rpc.inputType.range });
        refs.push({ name: rpc.outputType.name, range: rpc.outputType.range });
      }
    }
  }

  return refs;
}
