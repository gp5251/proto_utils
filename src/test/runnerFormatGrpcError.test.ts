import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { formatGrpcError } from '../runner/utils/formatGrpcError';

test('formats gRPC service error with code and details', () => {
  const err = Object.assign(new Error('14 UNAVAILABLE: Connection refused'), {
    code: grpc.status.UNAVAILABLE,
    details: 'Connection refused',
  });

  const text = formatGrpcError(err, 'localhost:50051');
  assert.ok(text.includes('状态码: UNAVAILABLE (14)'));
  assert.ok(text.includes('详情: Connection refused'));
  assert.ok(text.includes('服务器: localhost:50051'));
  assert.ok(text.includes('请确认 gRPC 服务 localhost:50051 已启动且可访问'));
});

test('formats plain Error', () => {
  const text = formatGrpcError(new Error('Something broke'));
  assert.ok(text.includes('消息: Something broke'));
});

test('handles non-error values', () => {
  assert.equal(formatGrpcError('raw failure'), 'raw failure');
});
