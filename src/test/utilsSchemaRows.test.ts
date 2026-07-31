import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSchemaRows } from '../utils/schemaRows';
import { FieldInfo } from '../call/types';

test('flattenSchemaRows builds field rows for top-level fields', () => {
  const fields: FieldInfo[] = [
    {
      name: 'status',
      type: 'enum',
      required: false,
      label: 'optional',
      protoType: 'TYPE_ENUM',
      refType: 'ResponseStatus',
    },
    {
      name: 'tipInfo',
      type: 'string',
      required: false,
      label: 'optional',
      protoType: 'TYPE_STRING',
      comment: '附带信息',
    },
  ];

  const rows = flattenSchemaRows(fields);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'field');
  assert.equal(rows[0].name, 'status');
  assert.equal(rows[0].typeLabel, 'ResponseStatus');
  assert.equal(rows[1].kind, 'field');
  assert.equal(rows[1].name, 'tipInfo');
  assert.equal(rows[1].typeLabel, 'string');
  assert.equal(rows[1].comment, '附带信息');
});

test('flattenSchemaRows propagates enum values for enum fields', () => {
  const fields: FieldInfo[] = [
    {
      name: 'plcState',
      type: 'enum',
      required: false,
      label: 'optional',
      protoType: 'TYPE_ENUM',
      refType: 'GCMPLCstate',
      enumValues: [
        { name: 'GCMPLCstate_UNKNOWN', number: 0 },
        { name: 'GCMPLCstate_RUN', number: 1 },
        { name: 'GCMPLCstate_STOP', number: 2 },
      ],
    },
  ];

  const rows = flattenSchemaRows(fields);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'field');
  assert.equal(rows[0].name, 'plcState');
  assert.equal(rows[0].typeLabel, 'GCMPLCstate');
  assert.deepEqual(rows[0].enumValues, [
    { name: 'GCMPLCstate_UNKNOWN', number: 0 },
    { name: 'GCMPLCstate_RUN', number: 1 },
    { name: 'GCMPLCstate_STOP', number: 2 },
  ]);
});

test('flattenSchemaRows builds nested children for message fields', () => {
  const fields: FieldInfo[] = [
    {
      name: 'info',
      type: 'message',
      required: false,
      label: 'optional',
      protoType: 'TYPE_MESSAGE',
      refType: 'Info',
      nestedFields: [
        {
          name: 'count',
          type: 'number',
          required: false,
          label: 'optional',
          protoType: 'TYPE_INT32',
        },
      ],
    },
  ];

  const rows = flattenSchemaRows(fields);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'field');
  assert.equal(rows[0].name, 'info');
  assert.equal(rows[0].typeLabel, 'Info');
  const children = rows[0].children;
  assert.ok(children);
  assert.equal(children.length, 1);
  assert.equal(children[0].kind, 'field');
  assert.equal(children[0].name, 'count');
  assert.equal(children[0].typeLabel, 'number');
  assert.equal(children[0].depth, 1);
});
