import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenTypesForRefs } from '../providers/semanticTokens';

/**
 * 语义 token 分类去重的契约测试(0.3.44,#12 性能):
 * 同名类型引用在一次 provideDocumentSemanticTokens 内反复出现,
 * resolve 必须只发生一次——大文件高频击键时全局档解析是 O(entries×symbols)。
 */

test('tokenTypesForRefs:同名引用只解析一次,memo 命中', () => {
  let calls = 0;
  const out = tokenTypesForRefs(['Foo', 'Foo', 'Bar', 'Foo'], (name) => {
    calls++;
    return name === 'Bar' ? 'enum' : 'other';
  });

  assert.deepEqual(out, [0, 0, 1, 0]);
  assert.equal(calls, 2, 'Foo 与 Bar 各解析一次,第三个 Foo 走 memo');
});

test('tokenTypesForRefs:空输入恒空数组', () => {
  assert.deepEqual(tokenTypesForRefs([], () => 'other'), []);
});

test('tokenTypesForRefs:全部同名只解析一次,分类一致传播', () => {
  let calls = 0;
  const out = tokenTypesForRefs(['X', 'X', 'X'], () => {
    calls++;
    return 'enum';
  });
  assert.deepEqual(out, [1, 1, 1]);
  assert.equal(calls, 1);
});
