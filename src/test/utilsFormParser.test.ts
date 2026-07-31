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
