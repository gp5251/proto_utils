/**
 * 响应 JSON → DevTools 风格折叠树行(0.3.41)。
 * 纯函数,零依赖:build.mjs 以 iife 打包为全局 ResultTree(ADR-0009,
 * 与 FormMapping 同一条共享源通道),node 测试直接 import 本文件,
 * 测试的正是浏览器跑的那份。
 *
 * 输入恒为已解析的 JSON 值(postMessage 结构化克隆,不可能成环;
 * 一元取 payload.result.data,流式取 chunk.data),构建永不失败——
 * 任意值至少产出一行,模板无需空态分支。
 */

export type TreeNodeKind =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'truncated';

export interface TreeNode {
  kind: TreeNodeKind;
  /**
   * 唯一路径:'' / "user" / "user"["tags"][0]。仅作展开态字典与 :key 的复合键,从不拆解。
   * 对象键段经 JSON.stringify 包裹:键名含点/方括号/空串时仍单射,
   * 不与嵌套路径碰撞(如 { 'x.y': 1, x: { y: 2 } } 两条路径不同)。
   */
  path: string;
  /** 根 = 0;渲染 padding-left = depth * 14 + 8(与 schema 行一致)。 */
  depth: number;
  /** 对象键名 / 数组下标('0')/ 根为 ''。 */
  key: string;
  /** 展示文本:{…} / […] / "str" / 3.14 / true / null / … */
  value: string;
  /** 容器子项数;标量 0。 */
  count: number;
  /** 容器子行;标量与空容器缺省。 */
  children?: TreeNode[];
}

/** 防深层递归爆栈(protobuf 消息实际远浅于此)。 */
export const MAX_DEPTH = 100;
/** 总行数预算;超出降级为一个截断标记行,避免全展开挂出巨量 DOM。 */
export const MAX_ROWS = 5000;
/** 长字符串截断长度。 */
export const MAX_VALUE_CHARS = 500;
/** 截断标记,纯符号 → 免 l10n。 */
export const ELLIPSIS = '…';

function kindOf(value: unknown): { kind: TreeNodeKind; text: string } {
  if (value === null) return { kind: 'null', text: 'null' };
  switch (typeof value) {
    case 'string': {
      const quoted = JSON.stringify(value);
      if (quoted.length <= MAX_VALUE_CHARS) return { kind: 'string', text: quoted };
      // 按码点截断:slice 可能劈开代理对,末字变 �
      return { kind: 'string', text: Array.from(quoted).slice(0, MAX_VALUE_CHARS).join('') + ELLIPSIS };
    }
    case 'number':
      return { kind: 'number', text: String(value) };
    case 'boolean':
      return { kind: 'boolean', text: value ? 'true' : 'false' };
    case 'bigint':
      // 防御分支:gRPC 解码不会产出 BigInt,仅为任意值不崩
      return { kind: 'number', text: String(value) };
    default:
      return { kind: 'null', text: String(value) };
  }
}

/** 预算耗尽/深度超限时的截断标记行。 */
function truncatedRow(path: string, key: string, depth: number): TreeNode {
  return { kind: 'truncated', path, key, depth, value: ELLIPSIS, count: 0 };
}

/** 容器子行构建:预算耗尽时只发一个截断标记行并停止(剩余未发射项不再建行)。 */
function buildChildren(
  entries: ReadonlyArray<readonly [string, unknown]>,
  basePath: string,
  depth: number,
  budget: { remaining: number },
  isArray: boolean,
): TreeNode[] {
  const children: TreeNode[] = [];
  for (const [k, v] of entries) {
    // 数组下标恒为数字,无需包裹;对象键段 JSON.stringify 包裹保证路径单射
    const childPath = isArray ? `${basePath}[${k}]` : basePath ? `${basePath}[${JSON.stringify(k)}]` : JSON.stringify(k);
    if (budget.remaining <= 0) {
      children.push(truncatedRow(childPath, k, depth + 1));
      break;
    }
    children.push(buildNode(v, childPath, k, depth + 1, budget));
  }
  return children;
}

function buildNode(value: unknown, path: string, key: string, depth: number, budget: { remaining: number }): TreeNode {
  if (budget.remaining <= 0) return truncatedRow(path, key, depth);
  budget.remaining--;
  if (depth >= MAX_DEPTH) return truncatedRow(path, key, depth);

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'array', path, key, depth, value: '[]', count: 0 };
    return {
      kind: 'array',
      path,
      key,
      depth,
      value: '[…]',
      count: value.length,
      children: buildChildren(value.map((item, i) => [String(i), item] as const), path, depth, budget, true),
    };
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return { kind: 'object', path, key, depth, value: '{}', count: 0 };
    return {
      kind: 'object',
      path,
      key,
      depth,
      value: '{…}',
      count: entries.length,
      children: buildChildren(entries, path, depth, budget, false),
    };
  }

  const scalar = kindOf(value);
  return { kind: scalar.kind, path, key, depth, value: scalar.text, count: 0 };
}

/** 任意 JSON 值 → 根行数组(恒单元素;根行 children 为顶层键)。 */
export function buildResultTree(value: unknown): TreeNode[] {
  return [buildNode(value, '', '', 0, { remaining: MAX_ROWS })];
}

/**
 * 按展开态把嵌套行拍平为可见行。isOpen 缺席一律 false(默认折叠);
 * 根行本身恒可见,其 children 是否可见由 isOpen('') 决定。
 */
export function visibleRows(rows: TreeNode[], isOpen: (path: string) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]): void => {
    for (const row of list) {
      out.push(row);
      if (row.children && row.children.length && isOpen(row.path)) walk(row.children);
    }
  };
  walk(rows);
  return out;
}

/** 流式 chunk 折叠条标签:'#1 · 342 B' / '#3 · 1.2 KB' / '#8 · 2.0 MB'(纯符号与数字,免 l10n)。 */
export function formatChunkLabel(index: number, byteLength: number): string {
  const size =
    byteLength < 1024
      ? `${byteLength} B`
      : byteLength < 1024 * 1024
        ? `${(byteLength / 1024).toFixed(1)} KB`
        : `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
  return `#${index + 1} · ${size}`;
}
