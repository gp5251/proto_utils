import { FieldInfo, EnumOption } from '../call/types';

export type SchemaRowKind = 'field';

export interface SchemaRow {
  kind: SchemaRowKind;
  path: string;
  depth: number;
  name: string;
  typeLabel: string;
  optional: boolean;
  comment?: string;
  enumValues?: EnumOption[];
  children?: SchemaRow[];
}

function fieldTypeLabel(field: FieldInfo): string {
  let type = field.refType || field.type;
  if (field.label === 'repeated') {
    type += '[]';
  }
  return type;
}

export function flattenSchemaRows(
  fields: FieldInfo[] | undefined,
  prefix = '',
  depth = 0
): SchemaRow[] {
  if (!fields?.length) {
    return [];
  }

  return fields.map((field) => {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const row: SchemaRow = {
      kind: 'field',
      path,
      depth,
      name: field.name,
      typeLabel: fieldTypeLabel(field),
      optional: !!field.optional,
      comment: field.comment,
    };

    if (field.protoType === 'TYPE_ENUM' && field.enumValues) {
      row.enumValues = field.enumValues;
    }

    if (field.protoType === 'TYPE_MESSAGE' && field.nestedFields?.length) {
      row.children = flattenSchemaRows(field.nestedFields, path, depth + 1);
    }

    return row;
  });
}
