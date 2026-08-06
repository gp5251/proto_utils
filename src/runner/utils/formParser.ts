import { FieldInfo } from '../core/types';

export function parseFormValue(field: FieldInfo, val: unknown): unknown {
  // repeated 非 message 字段:接受真数组或 JSON 数组字符串("[1,2,3]"),逐项按标量规则转换。
  // 必须放在 TYPE_BOOL 分支之前——否则数组会被 .some() 压成单个布尔值。
  if (field.label === 'repeated' && field.protoType !== 'TYPE_MESSAGE') {
    let arr: unknown[] | undefined;
    if (Array.isArray(val)) {
      arr = val;
    } else if (typeof val === 'string' && val.trim().startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(val);
        if (Array.isArray(parsed)) arr = parsed;
      } catch {
        // 非 JSON 数组,走下面的标量逻辑
      }
    }
    if (arr) {
      const scalar: FieldInfo = { ...field, label: 'optional' };
      return arr
        .map(item => parseFormValue(scalar, item))
        .filter(item => item !== undefined);
    }
  }

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
    // 真对象/数组直接透传(JSON 模式不经字符串化);字符串按 JSON 解析
    if (typeof val === 'object' && val !== null) {
      return val;
    }
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
