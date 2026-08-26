import { FieldInfo } from '../core/types';
import JSON5 from 'json5';

/**
 * JSON ↔ 表单值映射层(纯函数,无 DOM/Alpine 依赖)。
 * 移植自 rpc_runner client/formMapping.js(commit 702879a),语义逐条对齐;
 * 浏览器经 build.mjs 打成 media/runner/formMapping.js(iife,window.FormMapping),
 * 扩展与测试直接 import 本文件 —— 跑的是同一份代码。
 *
 * 表单值约定(与 media/runner/runner.js 的 formValues 一致):
 * - 键为 camelCase 字段名(FieldInfo.name)
 * - 标量一律是字符串('' 表示未填),TYPE_BOOL 是真布尔值
 * - 非 repeated 且带 nestedFields 的 message 是嵌套对象
 * - repeated 字段 / 无 nestedFields 的 message 是 textarea 里的 JSON 字符串
 *
 * 类型转换不归这里管:formParser.parseFormValue 是唯一转换权威。
 */

export type FormValues = Record<string, unknown>;

export type JsonValidation = { ok: true } | { ok: false; error: string };

export type ApplyJsonResult =
  | { ok: true; values: FormValues; warnings: string[] }
  | { ok: false; error: string };

// 蛇形转驼峰规则与 protoComments.ts storeFieldComment 内联的那套保持一致(基准仓为共享 snakeToCamel)
function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 单个 JSON 值 → 表单值。path 用于警告信息。 */
function jsonToFormValue(
  field: FieldInfo,
  v: unknown,
  currentValue: unknown,
  warnings: string[],
  path: string,
): unknown {
  // null/undefined 视为未提供:保留表单现值(合并语义)
  if (v === undefined || v === null) {
    return currentValue;
  }

  // 非 repeated 且带子表单的 message:递归合并
  if (field.protoType === 'TYPE_MESSAGE' && field.label !== 'repeated' && field.nestedFields?.length) {
    if (!isPlainObject(v)) {
      warnings.push(`${path}（应为对象，已忽略）`);
      return currentValue;
    }
    const merged = mergeObjectIntoValues(
      field.nestedFields,
      v,
      isPlainObject(currentValue) ? currentValue : {},
      path,
    );
    warnings.push(...merged.warnings);
    return merged.values;
  }

  // repeated 字段槽位是 JSON 字符串;标量/对象包装成单元素数组
  if (field.label === 'repeated') {
    if (typeof v === 'string') return v;
    return JSON.stringify(Array.isArray(v) ? v : [v]);
  }

  // 无 nestedFields 的 message:textarea 里是 JSON 字符串
  if (field.protoType === 'TYPE_MESSAGE') {
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  if (field.protoType === 'TYPE_BOOL') {
    // 与 formParser.parseFormValue 同一词表
    return v === true || v === 'true' || v === 'on';
  }

  if (field.protoType === 'TYPE_ENUM') {
    // 数字 → 枚举名(下拉框绑定的是枚举名)
    if (typeof v === 'number' && field.enumValues?.length) {
      const opt = field.enumValues.find((o) => o.number === v);
      return opt ? opt.name : String(v);
    }
    return String(v);
  }

  return String(v);
}

/**
 * 把 JSON 对象合并进表单值。只覆盖 JSON 里出现的键;
 * 同时接受 camelCase 与 snake_case 键(冲突时 camelCase 精确匹配优先)。
 */
function mergeObjectIntoValues(
  fields: FieldInfo[],
  obj: Record<string, unknown>,
  current: FormValues,
  prefix: string,
): { values: FormValues; warnings: string[] } {
  const values: FormValues = { ...current };
  const warnings: string[] = [];
  const pathOf = (key: string): string => (prefix ? `${prefix}.${key}` : key);
  const byName = new Map(fields.map((f) => [f.name, f]));

  const exact: string[] = [];
  const normalized: string[] = [];
  for (const key of Object.keys(obj)) {
    if (byName.has(key)) {
      exact.push(key);
    } else {
      normalized.push(key);
    }
  }

  for (const key of normalized.concat(exact)) {
    const field = byName.get(key) ?? byName.get(snakeToCamel(key));
    if (!field) {
      warnings.push(pathOf(key));
      continue;
    }
    values[field.name] = jsonToFormValue(field, obj[key], values[field.name], warnings, pathOf(key));
  }
  return { values, warnings };
}

/**
 * 校验 JSON/JSON5 文本(顶层必须是对象)。空文本视为合法。
 */
export function validateJsonText(text: string): JsonValidation {
  const trimmed = (text == null ? '' : String(text)).trim();
  if (!trimmed) {
    return { ok: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON5.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: '顶层必须是 JSON 对象' };
  }
  return { ok: true };
}

/**
 * 发送前表单值校验(0.3.44):逐字段检查表单值,返回「路径: 问题」清单,空数组 = 可发。
 * 空值(''/null/undefined)= 未填,不算问题。分支语义与 formParser.buildRequestFromValues
 * 一一对应——这里放行的值,转换层才不会把类型不符的文本原样发上线
 * (此前非法数字/坏 JSON 数组会静默发出,由 gRPC 序列化报出难懂的错误)。
 */
export function validateFormValues(fields: FieldInfo[], values: FormValues): string[] {
  const problems: string[] = [];
  const walk = (fs: FieldInfo[], vals: FormValues, prefix: string): void => {
    for (const f of fs) {
      const path = prefix ? `${prefix}.${f.name}` : f.name;
      const v = vals ? vals[f.name] : undefined;

      // 嵌套 message 表单:递归下钻
      if (f.protoType === 'TYPE_MESSAGE' && f.label !== 'repeated' && f.nestedFields?.length) {
        if (isPlainObject(v)) walk(f.nestedFields, v as FormValues, path);
        continue;
      }

      if (v === undefined || v === null || v === '') continue;

      // repeated 标量槽位是 JSON 数组字符串(真数组 = JSON 模式合并产物,放行)
      if (f.label === 'repeated' && f.protoType !== 'TYPE_MESSAGE') {
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (!t.startsWith('[')) {
          problems.push(`${path}: 应为 JSON 数组，如 [1,2]`);
          continue;
        }
        try {
          if (!Array.isArray(JSON5.parse(t))) problems.push(`${path}: 应为 JSON 数组，如 [1,2]`);
        } catch {
          problems.push(`${path}: JSON 数组解析失败`);
        }
        continue;
      }

      if (f.protoType === 'TYPE_BOOL') continue;

      // bytes:webview 文本框填 base64(线上编码),乱码在这里拦下而不是到服务端才炸
      if (f.protoType === 'TYPE_BYTES') {
        const s = String(v).trim();
        if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
          problems.push(`${path}: 应为 base64 编码`);
        }
        continue;
      }

      if (f.type === 'number') {
        if (Number.isNaN(Number(String(v)))) problems.push(`${path}: 不是合法数字`);
        continue;
      }

      // 无 nestedFields 的 message:textarea 里的 JSON 字符串(对象/数组均可)
      if (f.protoType === 'TYPE_MESSAGE') {
        if (typeof v !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON5.parse(v);
        } catch {
          problems.push(`${path}: JSON 解析失败`);
          continue;
        }
        if (!isPlainObject(parsed) && !Array.isArray(parsed)) problems.push(`${path}: 应为 JSON 对象`);
        continue;
      }
    }
  };
  walk(fields, values ?? {}, '');
  return problems;
}

/**
 * 解析 JSON/JSON5 文本并合并进当前表单值。
 */
export function applyJsonText(
  fields: FieldInfo[],
  text: string,
  currentValues: FormValues,
): ApplyJsonResult {
  const trimmed = (text == null ? '' : String(text)).trim();
  if (!trimmed) {
    return { ok: true, values: currentValues || {}, warnings: [] };
  }
  const check = validateJsonText(trimmed);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }
  const r = mergeObjectIntoValues(fields || [], JSON5.parse(trimmed) as Record<string, unknown>, currentValues || {}, '');
  return { ok: true, values: r.values, warnings: r.warnings };
}

/**
 * 表单值 → 纯 JSON 对象(供 JSON 标签页展示)。
 * 未填('')省略;布尔保留布尔;textarea 里的 JSON/JSON5 字符串还原为结构化 JSON,
 * 解析失败则原样保留字符串。
 */
export function formValuesToJson(fields: FieldInfo[], values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields || []) {
    const v = (values || {})[f.name];
    if (v === undefined || v === null || v === '') {
      continue;
    }
    if (f.protoType === 'TYPE_BOOL') {
      out[f.name] = v === true || v === 'true';
      continue;
    }
    if (f.protoType === 'TYPE_MESSAGE' && f.label !== 'repeated' && f.nestedFields?.length) {
      const nested = formValuesToJson(f.nestedFields, isPlainObject(v) ? v : {});
      if (Object.keys(nested).length) {
        out[f.name] = nested;
      }
      continue;
    }
    if (f.label === 'repeated') {
      // repeated 槽位是 JSON 字符串;标量值包装成单元素数组,保证线上一定是数组
      let parsedVal = v;
      if (typeof v === 'string') {
        try {
          parsedVal = JSON5.parse(v);
        } catch {
          out[f.name] = v;
          continue;
        }
      }
      out[f.name] = Array.isArray(parsedVal) ? parsedVal : [parsedVal];
      continue;
    }
    if (f.protoType === 'TYPE_MESSAGE') {
      if (typeof v === 'string') {
        try {
          out[f.name] = JSON5.parse(v);
        } catch {
          out[f.name] = v;
        }
      } else {
        out[f.name] = v;
      }
      continue;
    }
    if (f.type === 'number') {
      const n = Number(v);
      out[f.name] = Number.isNaN(n) ? v : n;
      continue;
    }
    out[f.name] = v;
  }
  return out;
}
