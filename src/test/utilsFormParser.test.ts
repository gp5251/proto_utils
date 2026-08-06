import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormValue, buildRequestFromValues } from '../runner/utils/formParser';
import { FieldInfo } from '../runner/core/types';

const boolField: FieldInfo = {
  name: 'enabled',
  type: 'boolean',
  required: false,
  label: 'optional',
  protoType: 'TYPE_BOOL',
};

const numberField: FieldInfo = {
  name: 'age',
  type: 'number',
  required: false,
  label: 'optional',
  protoType: 'TYPE_INT32',
};

test('parseFormValue parses unchecked bool as false', () => {
  assert.equal(parseFormValue(boolField, 'false'), false);
  assert.equal(parseFormValue(boolField, undefined), false);
});

test('parseFormValue parses checked bool as true', () => {
  assert.equal(parseFormValue(boolField, 'true'), true);
  assert.equal(parseFormValue(boolField, ['false', 'true']), true);
});

test('parseFormValue parses numbers', () => {
  assert.equal(parseFormValue(numberField, '42'), 42);
});

test('buildRequestFromValues includes false bool values', () => {
  const request = buildRequestFromValues([boolField], { enabled: 'false' });
  assert.equal(request.enabled, false);
});

// repeated 标量与 message 透传(同步自 rpc_runner 702879a 的 formParser 修复)
const repeatedNumberField: FieldInfo = {
  name: 'ids',
  type: 'number',
  required: false,
  label: 'repeated',
  protoType: 'TYPE_INT32',
};

const repeatedBoolField: FieldInfo = { ...repeatedNumberField, name: 'flags', type: 'boolean', protoType: 'TYPE_BOOL' };

const repeatedEnumField: FieldInfo = { ...repeatedNumberField, name: 'status', type: 'string', protoType: 'TYPE_ENUM' };

const messageField: FieldInfo = {
  name: 'payload',
  type: 'object',
  required: false,
  label: 'optional',
  protoType: 'TYPE_MESSAGE',
  refType: 'Payload',
};

test('parseFormValue repeated 标量:真数组逐项转换', () => {
  assert.deepEqual(parseFormValue(repeatedNumberField, ['1', '2', '3']), [1, 2, 3]);
});

test('parseFormValue repeated 标量:接受手输 JSON 数组字符串', () => {
  assert.deepEqual(parseFormValue(repeatedNumberField, '[1,2,3]'), [1, 2, 3]);
});

test('parseFormValue repeated bool 逐项转换而非 .some() 压平', () => {
  assert.deepEqual(parseFormValue(repeatedBoolField, [true, 'false', 'on']), [true, false, true]);
});

test('parseFormValue repeated enum 逐项转换(名称或数字)', () => {
  assert.deepEqual(parseFormValue(repeatedEnumField, ['ACTIVE', '1']), ['ACTIVE', 1]);
});

test('parseFormValue repeated:空元素丢弃', () => {
  assert.deepEqual(parseFormValue(repeatedNumberField, ['1', '', '2']), [1, 2]);
});

test('parseFormValue repeated:非数组输入回退标量逻辑', () => {
  assert.equal(parseFormValue(repeatedNumberField, '5'), 5);
  assert.equal(parseFormValue(repeatedNumberField, '[1,2'), '[1,2');
});

test('parseFormValue message:真对象/数组原样透传,不再字符串化', () => {
  const obj = { a: 1 };
  assert.equal(parseFormValue(messageField, obj), obj);
  const arr = [1, 2];
  assert.equal(parseFormValue(messageField, arr), arr);
});

test('buildRequestFromValues 从 JSON 数组字符串构建 repeated 标量数组', () => {
  const request = buildRequestFromValues([repeatedNumberField], { ids: '[1,2,3]' });
  assert.deepEqual(request, { ids: [1, 2, 3] });
});

test('buildRequestFromValues builds nested message objects', () => {
  const fields: FieldInfo[] = [{
    name: 'node',
    type: 'message',
    required: false,
    label: 'optional',
    protoType: 'TYPE_MESSAGE',
    refType: 'TreeNode',
    nestedFields: [{
      name: 'id',
      type: 'number',
      required: false,
      label: 'optional',
      protoType: 'TYPE_UINT32',
    }, {
      name: 'label',
      type: 'string',
      required: false,
      label: 'optional',
      protoType: 'TYPE_STRING',
    }],
  }];

  const request = buildRequestFromValues(fields, {
    node: { id: '1', label: 'test' },
  });

  assert.deepEqual(request, {
    node: { id: 1, label: 'test' },
  });
});
