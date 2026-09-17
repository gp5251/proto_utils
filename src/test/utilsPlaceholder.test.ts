import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getByPath,
  resolveString,
  resolveDeep,
  findInvalidRefs,
  PlaceholderError,
} from '../runner/utils/placeholder';

// ---- getByPath:点号/索引/引号键/整取/取不到 ----

test('getByPath:点号取键、嵌套、数组索引', () => {
  const root = { data: { token: 'abc', list: [{ id: 1 }, { id: 2 }] } };
  assert.deepEqual(getByPath(root, '.data.token'), { ok: true, value: 'abc' });
  assert.deepEqual(getByPath(root, 'data.token'), { ok: true, value: 'abc' });
  assert.deepEqual(getByPath(root, '.data.list[1].id'), { ok: true, value: 2 });
  assert.deepEqual(getByPath(root, ''), { ok: true, value: root }, '空路径取整个根');
});

test('getByPath:引号方括号取含特殊字符的键', () => {
  const root = { 'weird.key': 7, "q'x": 8 };
  assert.deepEqual(getByPath(root, '["weird.key"]'), { ok: true, value: 7 });
  assert.deepEqual(getByPath(root, `['q\\'x']`), { ok: true, value: 8 });
});

test('getByPath:取不到 → ok:false(键不存在/索引越界/对标量取键)', () => {
  const root = { a: { b: 1 }, arr: [0], s: 'str', n: null };
  assert.deepEqual(getByPath(root, '.a.missing'), { ok: false });
  assert.deepEqual(getByPath(root, '.arr[5]'), { ok: false });
  assert.deepEqual(getByPath(root, '.s.x'), { ok: false }, '字符串上取键');
  assert.deepEqual(getByPath(root, '.a[0]'), { ok: false }, '对象上取索引');
});

test('getByPath:null 是合法值(存在即返回),仅路径不存在才失败', () => {
  assert.deepEqual(getByPath({ n: null }, '.n'), { ok: true, value: null });
});

test('getByPath:非法路径语法 → ok:false', () => {
  assert.deepEqual(getByPath({ a: 1 }, '.a['), { ok: false });
  assert.deepEqual(getByPath({ a: 1 }, '[x]'), { ok: false });
});

// ---- resolveString:整值保类型 / 字符串插值 / 报错 ----

test('resolveString:整串单占位符 → 保留原始 JSON 类型', () => {
  const outputs = { 0: { data: { n: 42, b: true, obj: { k: 'v' }, arr: [1, 2] } } };
  assert.deepEqual(resolveString('{{step0.data.n}}', outputs, 1), 42);
  assert.deepEqual(resolveString('{{step0.data.b}}', outputs, 1), true);
  assert.deepEqual(resolveString('{{step0.data.obj}}', outputs, 1), { k: 'v' });
  assert.deepEqual(resolveString('{{step0.data.arr}}', outputs, 1), [1, 2]);
  assert.deepEqual(resolveString('  {{step0.data.n}}  ', outputs, 1), 42, '两侧空白仍算整值独占');
});

test('resolveString:嵌在字符串中 → 拼接为字符串,对象走 JSON', () => {
  const outputs = { 0: { data: { id: 7, obj: { k: 'v' } } } };
  assert.equal(resolveString('id-{{step0.data.id}}!', outputs, 1), 'id-7!');
  assert.equal(resolveString('{{step0.data.id}}/{{step0.data.id}}', outputs, 1), '7/7');
  assert.equal(resolveString('x{{step0.data.obj}}', outputs, 1), 'x{"k":"v"}');
});

test('resolveString:无占位符原样返回(含 null/undefined 值插值成空串)', () => {
  assert.equal(resolveString('plain', {}, 1), 'plain');
  const outputs = { 0: { data: { z: null } } };
  assert.equal(resolveString('v={{step0.data.z}}', outputs, 1), 'v=');
});

test('resolveString:路径取不到 → 抛 PlaceholderError 点名占位符', () => {
  const outputs = { 0: { data: {} } };
  assert.throws(
    () => resolveString('{{step0.data.nope}}', outputs, 1),
    (e: unknown) => e instanceof PlaceholderError && (e as PlaceholderError).ref === '{{step0.data.nope}}',
  );
});

test('resolveString:引用无输出的步 → 抛 PlaceholderError', () => {
  assert.throws(() => resolveString('{{step3.data.x}}', {}, 5), PlaceholderError);
});

test('resolveString:前向/自引用运行时兜底抛错', () => {
  const outputs = { 0: { data: { x: 1 } }, 2: { data: { y: 2 } } };
  assert.throws(() => resolveString('{{step2.data.y}}', outputs, 1), PlaceholderError, '引用后续步');
  assert.throws(() => resolveString('{{step1.data.y}}', outputs, 1), PlaceholderError, '引用自身');
});

test('resolveString:结构非法的占位符 → 抛 PlaceholderError', () => {
  assert.throws(() => resolveString('{{foo}}', {}, 1), PlaceholderError);
  assert.throws(() => resolveString('{{step0x}}', {}, 1), PlaceholderError);
});

// ---- 流步骤 chunks 引用 ----

test('流步输出 {chunks:[{data}...]}:按索引引用某条 chunk 的字段', () => {
  const outputs = { 0: { chunks: [{ data: { t: 'a' } }, { data: { t: 'b' } }] } };
  assert.equal(resolveString('{{step0.chunks[1].data.t}}', outputs, 1), 'b');
  assert.throws(() => resolveString('{{step0.chunks[9].data.t}}', outputs, 1), PlaceholderError);
});

// ---- findInvalidRefs:编辑时静态标红 ----

test('findInvalidRefs:标出前向/自引用与结构非法,放过合法前序引用', () => {
  const bad = findInvalidRefs('{{step0.a}} {{step2.b}} {{step1.c}} {{oops}}', 1);
  const raws = bad.map((b) => b.raw);
  assert.ok(!raws.includes('{{step0.a}}'), '前序合法引用不标');
  assert.ok(raws.includes('{{step2.b}}'), '后续步标红');
  assert.ok(raws.includes('{{step1.c}}'), '自引用标红');
  assert.ok(raws.includes('{{oops}}'), '非法结构标红');
});

test('findInvalidRefs:路径能否取到值属运行时,静态不判', () => {
  assert.deepEqual(findInvalidRefs('{{step0.deep.missing}}', 1), []);
});

// ---- resolveDeep:深度遍历 ----

test('resolveDeep:遍历对象/数组解析字符串叶,非字符串标量原样', () => {
  const outputs = { 0: { data: { id: 9, name: 'x' } } };
  const input = {
    uid: '{{step0.data.id}}',
    label: 'n={{step0.data.name}}',
    plain: 'no placeholder',
    count: 3,
    flag: true,
    nested: { arr: ['{{step0.data.id}}', 'lit', { deep: '{{step0.data.name}}' }] },
  };
  assert.deepEqual(resolveDeep(input, outputs, 1), {
    uid: 9,
    label: 'n=x',
    plain: 'no placeholder',
    count: 3,
    flag: true,
    nested: { arr: [9, 'lit', { deep: 'x' }] },
  });
});
