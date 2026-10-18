import JSON5 from 'json5';
import { getByPath, resolveString, resolveVars } from './utils/placeholder';
import type { StepAssertion } from './sequenceStore';

/**
 * 序列步骤断言求值(0.3.78):纯函数。取值根 = 该步输出({data} 或 {chunks,dropped,count})+ durationMs,
 * path 语法同占位符;expected 先替换环境变量与 {{stepN}} 引用,再尝试按 JSON5 解析成数字/布尔/对象。
 */
export interface AssertionResult {
  path: string;
  op: StepAssertion['op'];
  expected?: string;
  ok: boolean;
  /** 实际值的展示文本;路径取不到为 undefined */
  actual?: string;
  /** expected 解析失败等求值错误 */
  error?: string;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
}

function show(v: unknown): string {
  const s = text(v);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// ponytail: 宽松相等——对象比 JSON 文本,标量比 String(1 == "1");需要严格类型断言时再加 op
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

function parseExpected(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON5.parse(raw);
  } catch {
    return raw;
  }
}

export function evaluateAssertions(
  assertions: StepAssertion[],
  stepOutput: unknown,
  durationMs: number,
  outputs: Record<number, unknown>,
  index: number,
  vars: Record<string, string>,
): AssertionResult[] {
  const root = { ...(stepOutput as Record<string, unknown>), durationMs };
  return assertions.map((a) => {
    const base: AssertionResult = { path: a.path, op: a.op, expected: a.expected, ok: false };
    const got = getByPath(root, a.path);
    if (got.ok) base.actual = show(got.value);
    if (a.op === 'exists') return { ...base, ok: got.ok };
    if (a.op === 'notExists') return { ...base, ok: !got.ok };
    let exp: unknown;
    try {
      exp = parseExpected(resolveString(resolveVars(a.expected ?? '', vars) as string, outputs, index));
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
    if (!got.ok) return base;
    const v = got.value;
    switch (a.op) {
      case 'eq':
        return { ...base, ok: same(v, exp) };
      case 'neq':
        return { ...base, ok: !same(v, exp) };
      case 'contains':
        return { ...base, ok: Array.isArray(v) ? v.some((item) => same(item, exp)) : text(v).includes(String(exp)) };
      case 'lt':
      case 'gt': {
        const x = Number(v);
        const y = Number(exp);
        const ok = Number.isFinite(x) && Number.isFinite(y) && (a.op === 'lt' ? x < y : x > y);
        return { ...base, ok };
      }
    }
    return base;
  });
}
