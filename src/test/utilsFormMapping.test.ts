import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyJsonText, formValuesToJson, validateJsonText } from '../runner/utils/formMapping';
import { FieldInfo } from '../runner/core/types';

/**
 * formMapping 的契约测试:逐条移植 rpc_runner client/__tests__/formMapping.test.js
 * (vitest 23 用例 → node:test),fixtures 与期望保持一致——
 * 两侧 UI 的 JSON↔表单映射语义必须逐字节同构。
 */

const fields: FieldInfo[] = [
  { name: 'fileId', type: 'number', required: false, label: 'optional', protoType: 'TYPE_UINT32' },
  { name: 'bShowComment', type: 'boolean', required: false, label: 'optional', protoType: 'TYPE_BOOL' },
  {
    name: 'status', type: 'string', required: false, label: 'optional', protoType: 'TYPE_ENUM',
    enumValues: [{ name: 'UNKNOWN', number: 0 }, { name: 'ACTIVE', number: 1 }],
  },
  { name: 'note', type: 'string', required: false, label: 'optional', protoType: 'TYPE_STRING' },
  { name: 'ids', type: 'number', required: false, label: 'repeated', protoType: 'TYPE_INT32' },
  {
    name: 'node', type: 'object', required: false, label: 'optional', protoType: 'TYPE_MESSAGE', refType: 'Node',
    nestedFields: [
      { name: 'id', type: 'number', required: false, label: 'optional', protoType: 'TYPE_UINT32' },
      { name: 'childName', type: 'string', required: false, label: 'optional', protoType: 'TYPE_STRING' },
    ],
  },
  { name: 'items', type: 'object', required: false, label: 'repeated', protoType: 'TYPE_MESSAGE', refType: 'Item' },
];

test('applyJsonText: camelCase 键映射为表单表示(数字转字符串)', () => {
  const r = applyJsonText(fields, '{"fileId": 7, "bShowComment": true, "note": "hi"}', {});
  assert.ok(r.ok);
  assert.deepEqual(r.values, { fileId: '7', bShowComment: true, note: 'hi' });
});

test('applyJsonText: 接受 snake_case 键', () => {
  const r = applyJsonText(fields, '{"file_id": 7, "b_show_comment": false}', {});
  assert.ok(r.ok);
  assert.deepEqual(r.values, { fileId: '7', bShowComment: false });
});

test('applyJsonText: file_id/fileId 冲突时精确 camelCase 优先', () => {
  const r = applyJsonText(fields, '{"file_id": 1, "fileId": 2}', {});
  assert.ok(r.ok);
  assert.equal(r.values.fileId, '2');
});

test('applyJsonText: 合并语义,JSON 未出现的键保留现值', () => {
  const r = applyJsonText(fields, '{"fileId": 9}', { note: 'keep', fileId: '1' });
  assert.ok(r.ok);
  assert.deepEqual(r.values, { note: 'keep', fileId: '9' });
});

test('applyJsonText: 未知键收进 warnings 且已知字段照常填', () => {
  const r = applyJsonText(fields, '{"fileId": 1, "nope": 2}', {});
  assert.ok(r.ok);
  assert.deepEqual(r.warnings, ['nope']);
  assert.equal(r.values.fileId, '1');
});

test('applyJsonText: 嵌套未知键以点路径报警', () => {
  const r = applyJsonText(fields, '{"node": {"id": 1, "zzz": true}}', {});
  assert.ok(r.ok);
  assert.deepEqual(r.warnings, ['node.zzz']);
  assert.deepEqual(r.values.node, { id: '1' });
});

test('applyJsonText: 嵌套 message 深合并', () => {
  const current = { node: { id: '1', childName: 'old' } };
  const r = applyJsonText(fields, '{"node": {"child_name": "new"}}', current);
  assert.ok(r.ok);
  assert.deepEqual(r.values.node, { id: '1', childName: 'new' });
});

test('applyJsonText: 枚举数字映射为枚举名,名称字符串原样保留', () => {
  const byNumber = applyJsonText(fields, '{"status": 1}', {});
  assert.ok(byNumber.ok);
  assert.equal(byNumber.values.status, 'ACTIVE');
  const byName = applyJsonText(fields, '{"status": "UNKNOWN"}', {});
  assert.ok(byName.ok);
  assert.equal(byName.values.status, 'UNKNOWN');
});

test('applyJsonText: 数组/对象字符串化进 repeated/message 的 textarea 槽', () => {
  const r = applyJsonText(fields, '{"ids": [1, 2], "items": [{"a": 1}]}', {});
  assert.ok(r.ok);
  assert.equal(r.values.ids, '[1,2]');
  assert.equal(r.values.items, '[{"a":1}]');
});

test('applyJsonText: null 视为未提供,保留现值', () => {
  const r = applyJsonText(fields, '{"note": null}', { note: 'keep' });
  assert.ok(r.ok);
  assert.equal(r.values.note, 'keep');
});

test('applyJsonText: 无效 JSON 拒绝且不碰 values', () => {
  const r = applyJsonText(fields, '{"fileId": ', { note: 'x' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /JSON 解析失败/);
});

test('applyJsonText: 顶层非对象(数组/字符串)拒绝', () => {
  assert.equal(applyJsonText(fields, '[1,2]', {}).ok, false);
  assert.equal(applyJsonText(fields, '"str"', {}).ok, false);
});

test('applyJsonText: 空文本 no-op 返回现值', () => {
  const r = applyJsonText(fields, '  ', { note: 'x' });
  assert.deepEqual(r, { ok: true, values: { note: 'x' }, warnings: [] });
});

test('applyJsonText: bool 按服务端词表转换("0"→false,"on"→true,"TRUE"→false)', () => {
  const zero = applyJsonText(fields, '{"bShowComment": "0"}', {});
  assert.ok(zero.ok);
  assert.equal(zero.values.bShowComment, false);
  const on = applyJsonText(fields, '{"bShowComment": "on"}', {});
  assert.ok(on.ok);
  assert.equal(on.values.bShowComment, true);
  const upper = applyJsonText(fields, '{"bShowComment": "TRUE"}', {});
  assert.ok(upper.ok);
  assert.equal(upper.values.bShowComment, false);
});

test('applyJsonText: repeated 字段的标量 JSON 值包成单元素数组', () => {
  const r = applyJsonText(fields, '{"ids": 5}', {});
  assert.ok(r.ok);
  assert.equal(r.values.ids, '[5]');
});

test('validateJsonText: 接受空串与普通对象', () => {
  assert.equal(validateJsonText('').ok, true);
  assert.equal(validateJsonText('{"a": 1}').ok, true);
});

test('validateJsonText: 拒绝残缺 JSON、顶层数组、顶层字符串', () => {
  assert.equal(validateJsonText('{"a": ').ok, false);
  assert.equal(validateJsonText('[1,2]').ok, false);
  assert.equal(validateJsonText('"str"').ok, false);
});

test('validateJsonText: 接受 JSON5(注释/裸键名/单引号/尾逗号)', () => {
  assert.equal(validateJsonText(`{
    // 行注释
    fileId: 1,
    'note': "hi", /* 块注释 */
  }`).ok, true);
});

test('applyJsonText: JSON5 宽松语法(注释/裸键名/单引号/尾逗号/十六进制)', () => {
  const r = applyJsonText(fields, `{
    // 行注释
    fileId: 0x1f, // 31
    'bShowComment': true, /* 尾逗号 */
  }`, {});
  assert.ok(r.ok);
  assert.deepEqual(r.values, { fileId: '31', bShowComment: true });
});

test('formValuesToJson: textarea 槽位 JSON5 字符串解析回结构化值', () => {
  const out = formValuesToJson(fields, { ids: '[1, 2,]', items: "{a: 1,}" });
  assert.deepEqual(out.ids, [1, 2]);
  assert.deepEqual(out.items, [{ a: 1 }]); // items 是 repeated message,按契约包成数组
});

test('formValuesToJson: 省略未设值字段、保留 bool、数字字符串转数字', () => {
  const out = formValuesToJson(fields, {
    fileId: '7', bShowComment: true, note: '', status: 'ACTIVE',
  });
  assert.deepEqual(out, { fileId: 7, bShowComment: true, status: 'ACTIVE' });
});

test('formValuesToJson: textarea 的 JSON 字符串解析回结构化值', () => {
  const out = formValuesToJson(fields, { ids: '[1,2]', items: '[{"a":1}]' });
  assert.deepEqual(out.ids, [1, 2]);
  assert.deepEqual(out.items, [{ a: 1 }]);
});

test('formValuesToJson: 无效 textarea JSON 保留原始字符串', () => {
  const out = formValuesToJson(fields, { ids: '[1,2' });
  assert.equal(out.ids, '[1,2');
});

test('formValuesToJson: repeated 单值包数组', () => {
  const out = formValuesToJson(fields, { ids: '5' });
  assert.deepEqual(out.ids, [5]);
});

test('formValuesToJson: 递归嵌套 message 并丢弃空对象', () => {
  const out = formValuesToJson(fields, {
    node: { id: '3', childName: '' },
    items: '',
  });
  assert.deepEqual(out, { node: { id: 3 } });
});

test('form→JSON→form 往返是不动点', () => {
  const form = { fileId: '7', bShowComment: true, status: 'ACTIVE', ids: '[1,2]', node: { id: '3' } };
  const json = formValuesToJson(fields, form);
  const r = applyJsonText(fields, JSON.stringify(json), {});
  assert.ok(r.ok);
  assert.equal(r.values.fileId, '7');
  assert.equal(r.values.bShowComment, true);
  assert.equal(r.values.status, 'ACTIVE');
  assert.equal(r.values.ids, '[1,2]');
  assert.deepEqual(r.values.node, { id: '3' });
});
