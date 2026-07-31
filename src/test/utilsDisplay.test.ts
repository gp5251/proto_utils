import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatResponse } from '../utils/display';
import { CallOk, CallError } from '../call/types';

test('formatResponse formats ok result with data', () => {
  const result: CallOk = {
    status: 'ok',
    data: { name: 'test', count: 42 },
    durationMs: 150,
  };
  const output = formatResponse(result);
  assert.ok(output.includes('OK'));
  assert.ok(output.includes('150ms'));
  assert.ok(output.includes('"name"'));
  assert.ok(output.includes('42'));
});

test('formatResponse formats ok result with null data', () => {
  const result: CallOk = {
    status: 'ok',
    data: null,
    durationMs: 10,
  };
  const output = formatResponse(result);
  assert.ok(output.includes('OK'));
  assert.ok(output.includes('10ms'));
});

test('formatResponse formats error result', () => {
  const result: CallError = {
    status: 'error',
    error: 'Connection refused',
    durationMs: 50,
  };
  const output = formatResponse(result);
  assert.ok(output.includes('ERROR'));
  assert.ok(output.includes('Connection refused'));
  assert.ok(output.includes('50ms'));
});
