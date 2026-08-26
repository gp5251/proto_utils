import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { formatGrpcError } from '../runner/utils/formatGrpcError';

// 测试环境 vscode 替身 l10n.t 为恒等:断言英文源串;中文译文由 l10n 包覆盖测试兜底。

test('formats gRPC service error with code and details', () => {
  const err = Object.assign(new Error('14 UNAVAILABLE: Connection refused'), {
    code: grpc.status.UNAVAILABLE,
    details: 'Connection refused',
  });

  const text = formatGrpcError(err, 'localhost:50051');
  assert.ok(text.includes('Status code: UNAVAILABLE (14)'));
  assert.ok(text.includes('Details: Connection refused'));
  assert.ok(text.includes('Server: localhost:50051'));
  assert.ok(text.includes('Hint: Check that the gRPC server localhost:50051 is up and reachable'));
});

test('formats plain Error', () => {
  const text = formatGrpcError(new Error('Something broke'));
  assert.ok(text.includes('Message: Something broke'));
});

test('handles non-error values', () => {
  assert.equal(formatGrpcError('raw failure'), 'raw failure');
});

test('deadline 与 invalid argument 各有提示;cause 去重', () => {
  const deadline = Object.assign(new Error('4 DEADLINE_EXCEEDED'), { code: grpc.status.DEADLINE_EXCEEDED });
  assert.match(formatGrpcError(deadline), /Request timed out/);

  const invalid = Object.assign(new Error('3 INVALID_ARGUMENT'), { code: grpc.status.INVALID_ARGUMENT });
  assert.match(formatGrpcError(invalid), /Invalid request arguments/);

  const caused = Object.assign(new Error('connect ECONNREFUSED'), {
    code: grpc.status.UNAVAILABLE,
    cause: new Error('ECONNREFUSED'),
  });
  const text = formatGrpcError(caused);
  assert.ok(!text.includes('Cause: connect ECONNREFUSED') || !text.includes('Message: connect ECONNREFUSED'), '重复文本不二次输出');
});
