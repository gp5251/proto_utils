import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResultTree,
  visibleRows,
  collectContainerPaths,
  formatChunkLabel,
  MAX_DEPTH,
  MAX_ROWS,
  MAX_VALUE_CHARS,
  ELLIPSIS,
  TreeNode,
} from '../runner/utils/resultTree';

/** 收集树里全部节点(展开所有 children),便于断言。 */
function allNodes(rows: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]): void => {
    for (const row of list) {
      out.push(row);
      if (row.children) walk(row.children);
    }
  };
  walk(rows);
  return out;
}

test('对象树:根行 + 顶层键子行,path/depth/key/count 正确', () => {
  const rows = buildResultTree({ a: { b: 1 }, c: [2, 3] });
  assert.equal(rows.length, 1, '恒单根行');
  const root = rows[0];
  assert.equal(root.kind, 'object');
  assert.equal(root.path, '');
  assert.equal(root.depth, 0);
  assert.equal(root.key, '');
  assert.equal(root.value, '{…}');
  assert.equal(root.count, 2);
  assert.ok(root.children);
  const nodes = allNodes(rows).map((n) => n.path);
  assert.deepEqual(nodes, ['', '"a"', '"a"["b"]', '"c"', '"c"[0]', '"c"[1]']);
  assert.equal(allNodes(rows)[3].value, '[…]', '数组容器摘要');
  assert.equal(allNodes(rows)[5].key, '1', '数组下标作 key');
});

test('路径单射:键名含点/方括号/空串不与嵌套路径碰撞(展开态与 :key 共用 path)', () => {
  const rows = buildResultTree({ 'x.y': 1, x: { y: 2 }, '': 3, 'a[0]': 4, a: [5] });
  const paths = allNodes(rows).map((n) => n.path);
  assert.deepEqual(paths, ['', '"x.y"', '"x"', '"x"["y"]', '""', '"a[0]"', '"a"', '"a"[0]']);
  assert.equal(new Set(paths).size, paths.length, '路径两两不同');
  // 展开态按路径隔离:开根 + "x" 只出嵌套 y,不带动 "x.y" 键
  const visible = visibleRows(rows, (p) => p === '' || p === '"x"');
  assert.deepEqual(visible.map((n) => n.path), ['', '"x.y"', '"x"', '"x"["y"]', '""', '"a[0]"', '"a"']);
});

test('标量:字符串 JSON.stringify 转义、数字/布尔/null 各自 kind 与文本', () => {
  const rows = buildResultTree({ s: 'hi"x', n: 3.14, b: true, z: null });
  const byPath = new Map(allNodes(rows).map((n) => [n.path, n]));
  assert.equal(byPath.get('"s"')?.value, '"hi\\"x"', '字符串带引号转义');
  assert.equal(byPath.get('"s"')?.kind, 'string');
  assert.equal(byPath.get('"n"')?.value, '3.14');
  assert.equal(byPath.get('"n"')?.kind, 'number');
  assert.equal(byPath.get('"b"')?.value, 'true');
  assert.equal(byPath.get('"b"')?.kind, 'boolean');
  assert.equal(byPath.get('"z"')?.value, 'null');
  assert.equal(byPath.get('"z"')?.kind, 'null');
});

test('空容器:无 children,值为 {} / [] 的叶行;根标量单行', () => {
  const empty = buildResultTree({ a: {}, b: [] });
  const byPath = new Map(allNodes(empty).map((n) => [n.path, n]));
  assert.equal(byPath.get('"a"')?.children, undefined);
  assert.equal(byPath.get('"a"')?.value, '{}');
  assert.equal(byPath.get('"b"')?.children, undefined);
  assert.equal(byPath.get('"b"')?.value, '[]');
  const scalarRoot = buildResultTree(42);
  assert.equal(scalarRoot.length, 1);
  assert.equal(scalarRoot[0].value, '42');
  assert.equal(scalarRoot[0].children, undefined);
});

test('长字符串截断 + 后缀省略号,kind 不变', () => {
  const long = 'x'.repeat(MAX_VALUE_CHARS + 10);
  const rows = buildResultTree({ s: long });
  const s = allNodes(rows).find((n) => n.path === '"s"');
  assert.ok(s);
  // 引号内截到 500 码点后拼省略号:总长 501,以引号起、省略号止
  assert.equal(s.value.length, MAX_VALUE_CHARS + 1);
  assert.ok(s.value.startsWith('"'));
  assert.ok(s.value.endsWith(ELLIPSIS));
  assert.equal(s.kind, 'string');
});

test('代理对截断:按码点切,末位不落孤立代理', () => {
  const emoji = '😀'.repeat(MAX_VALUE_CHARS);
  const rows = buildResultTree({ s: emoji });
  const s = allNodes(rows).find((n) => n.path === '"s"');
  assert.ok(s);
  assert.ok(s.value.endsWith(ELLIPSIS));
  // 截断点后无孤立高低代理(不会渲染出 �):末字符不是孤立高代理
  assert.ok(!/(?:^|[^\uD800-\uDBFF])[\uD800-\uDBFF]$/.test(s.value.slice(0, -1)), '末字符不是孤立高代理');
});

test('行数预算:超出 MAX_ROWS 只发一个截断标记行,其余不建行', () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < MAX_ROWS + 50; i++) wide[`k${i}`] = i;
  const rows = buildResultTree(wide);
  const nodes = allNodes(rows);
  // 根 1 + 子 MAX_ROWS-1 + 标记 1
  assert.equal(nodes.length, MAX_ROWS + 1);
  assert.equal(nodes.filter((n) => n.kind === 'truncated').length, 1, '恰好一个截断标记');
});

test('深度上限:超 MAX_DEPTH 处截断,不爆栈', () => {
  let deep: unknown = 1;
  for (let i = 0; i < MAX_DEPTH + 20; i++) deep = { next: deep };
  const rows = buildResultTree(deep);
  const nodes = allNodes(rows);
  assert.ok(nodes.some((n) => n.kind === 'truncated'));
});

test('CJK/HTML 文本原样保留(转义是 x-text 渲染时的职责)', () => {
  const rows = buildResultTree({ v: '<script>alert(1)</script> 中文' });
  const v = allNodes(rows).find((n) => n.path === '"v"');
  assert.ok(v?.value.includes('<script>alert(1)</script> 中文'));
});

test('visibleRows:默认全折叠只出根行;沿展开链渲染;展开态互不泄漏', () => {
  const rows = buildResultTree({ a: { b: { c: 1 }, d: 2 }, e: 3 });
  const open = new Set<string>();
  assert.deepEqual(visibleRows(rows, (p) => open.has(p)).map((n) => n.path), ['']);
  open.add('');
  open.add('"a"');
  // a 展开后其全部子行(a.b 容器行与 a.d 叶行)可见;a.b 自身未展开,其子 c 不可见
  assert.deepEqual(
    visibleRows(rows, (p) => open.has(p)).map((n) => n.path),
    ['', '"a"', '"a"["b"]', '"a"["d"]', '"e"'],
  );
  open.add('"a"["b"]');
  assert.deepEqual(
    visibleRows(rows, (p) => open.has(p)).map((n) => n.path),
    ['', '"a"', '"a"["b"]', '"a"["b"]["c"]', '"a"["d"]', '"e"'],
  );
  // 另一棵树的 isOpen 状态不影响本树
  const other = buildResultTree({ a: { z: 9 } });
  assert.deepEqual(visibleRows(other, (p) => p === '').map((n) => n.path), ['', '"a"']);
});

test('formatChunkLabel:序号 + 字节/B/KB/MB 三档', () => {
  assert.equal(formatChunkLabel(0, 342), '#1 · 342 B');
  assert.equal(formatChunkLabel(2, 1024 * 1.2), '#3 · 1.2 KB');
  assert.equal(formatChunkLabel(7, 1024 * 1024 * 2), '#8 · 2.0 MB');
});

test('collectContainerPaths:全部容器路径含根行;叶与空容器不收', () => {
  const rows = buildResultTree({ a: { b: 1 }, list: [{ id: 1 }], empty: {}, s: 'x' });
  const paths = collectContainerPaths(rows);
  assert.deepEqual(paths, ['', '"a"', '"list"', '"list"[0]']);
  // 与 visibleRows 联用:全部展开 = 全部节点可见
  const open = new Set(paths);
  assert.equal(visibleRows(rows, (p) => open.has(p)).length, allNodes(rows).length);
});

test('collectContainerPaths:根标量只有根行且根行非容器 → 空集', () => {
  assert.deepEqual(collectContainerPaths(buildResultTree(42)), []);
});
