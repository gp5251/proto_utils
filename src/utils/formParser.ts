import { FieldInfo } from '../call/types';

export function parseFormValue(field: FieldInfo, val: unknown): unknown {
  if (field.protoType === 'TYPE_BOOL') {
    if (Array.isArray(val)) {
      return val.some(item => item === 'true' || item === true || item === 'on');
    }
    return val === 'true' || val === true || val === 'on';
  }

  if (val === undefined || val === null || val === '') {
    return undefined;
  }

  const strVal = String(val);

  if (field.type === 'number') {
    const n = Number(strVal);
    return Number.isNaN(n) ? strVal : n;
  }

  if (field.protoType === 'TYPE_MESSAGE') {
    try {
      return JSON.parse(strVal);
    } catch {
      return strVal;
    }
  }

  if (field.protoType === 'TYPE_ENUM') {
    const n = Number(strVal);
    if (!Number.isNaN(n) && String(n) === strVal.trim()) {
      return n;
    }
    return strVal;
  }

  return strVal;
}

export function buildRequestFromValues(
  fields: FieldInfo[],
  values: Record<string, unknown>
): Record<string, unknown> {
  const request: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = values[field.name];

    if (field.protoType === 'TYPE_MESSAGE' && field.label !== 'repeated' && field.nestedFields?.length) {
      const nestedValues: Record<string, unknown> =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : {};
      const nested = buildRequestFromValues(field.nestedFields, nestedValues);
      if (Object.keys(nested).length > 0) {
        request[field.name] = nested;
      }
      continue;
    }

    const parsed = parseFormValue(field, raw);

    if (field.protoType === 'TYPE_BOOL') {
      request[field.name] = parsed;
      continue;
    }

    if (parsed !== undefined) {
      request[field.name] = parsed;
    }
  }

  return request;
}

export function buildRequestFromForm(
  fieldNames: string[],
  fields: FieldInfo[],
  body: Record<string, unknown>
): { request: Record<string, unknown>; values: Record<string, string> } {
  const request: Record<string, unknown> = {};
  const values: Record<string, string> = {};

  for (const name of fieldNames) {
    const field = fields.find(f => f.name === name);
    if (!field) {
      continue;
    }

    const rawVal = body[`field_${name}`];
    const parsed = parseFormValue(field, rawVal);

    if (field.protoType === 'TYPE_BOOL') {
      request[name] = parsed;
      values[name] = parsed ? 'true' : 'false';
      continue;
    }

    if (parsed !== undefined) {
      request[name] = parsed;
      values[name] = rawVal !== undefined && rawVal !== null ? String(rawVal) : '';
    }
  }

  return { request, values };
}
