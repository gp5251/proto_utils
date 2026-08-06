import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GrpcCallRunner, GrpcTransport } from '../runner/callHandler';
import { ServiceRegistry } from '../runner/serviceRegistry';
import { CallResult, StreamHandlers } from '../runner/core/types';

/**
 * callHandler 的 spec 契约测试:注入 fake GrpcClient 工厂,
 * 覆盖 成功载荷组装 / 调用错误 / 非法 JSON _raw 回退 / 流式委托与取消。
 */

const RUNNER_DIR = path.resolve('testdata/runner');

function makeRunner(transport: GrpcTransport): GrpcCallRunner {
  return new GrpcCallRunner('fake:0', RUNNER_DIR, new ServiceRegistry(), () => transport);
}

test('callUnary: values 经字段 schema 解析后发出,载荷含 requestType 与格式化 resultBody', async () => {
  let seenRequest: unknown;
  const transport: GrpcTransport = {
    call: async (_dir, options) => {
      seenRequest = options.request;
      const ok: CallResult = { status: 'ok', data: { ok: true }, durationMs: 3 };
      return ok;
    },
    callServerStream: () => {
      throw new Error('not used');
    },
  };
  const runner = makeRunner(transport);

  // optional.proto 的 SetVar:index 是 proto3 optional int32,values 传字符串数字
  const payload = await runner.callUnary('VarService', 'SetVar', { index: '42', name: 'x' });

  assert.deepEqual(seenRequest, { index: 42, name: 'x' });
  assert.equal(payload.requestType, 'SetVarRequest');
  assert.equal(payload.responseType, 'SetVarResponse');
  assert.equal(payload.result.status, 'ok');
  assert.match(payload.resultBody, /"ok": true/);
});

test('callUnary: 调用错误进 result,resultBody 为错误文本', async () => {
  const transport: GrpcTransport = {
    call: async () => ({ status: 'error', error: 'UNAVAILABLE: down', durationMs: 1 }),
    callServerStream: () => {
      throw new Error('not used');
    },
  };
  const payload = await makeRunner(transport).callUnary('VarService', 'SetVar', {});
  assert.equal(payload.result.status, 'error');
  assert.equal(payload.resultBody, 'UNAVAILABLE: down');
});

test('callUnary: 未知方法时无 schema,合法 _raw JSON 兜底为请求体', async () => {
  let seenRequest: unknown;
  const transport: GrpcTransport = {
    call: async (_dir, options) => {
      seenRequest = options.request;
      return { status: 'ok', data: {}, durationMs: 1 };
    },
    callServerStream: () => {
      throw new Error('not used');
    },
  };
  const payload = await makeRunner(transport).callUnary('NoSuchService', 'Nope', { _raw: '{"a":1}' });
  assert.deepEqual(seenRequest, { a: 1 });
  assert.equal(payload.requestType, 'unknown');
});

test('callUnary: 非法 _raw JSON 回退为空对象', async () => {
  let seenRequest: unknown;
  const transport: GrpcTransport = {
    call: async (_dir, options) => {
      seenRequest = options.request;
      return { status: 'ok', data: {}, durationMs: 1 };
    },
    callServerStream: () => {
      throw new Error('not used');
    },
  };
  await makeRunner(transport).callUnary('NoSuchService', 'Nope', { _raw: '{not json' });
  assert.deepEqual(seenRequest, {});
});

test('callUnary: _raw 顶层数组拒绝,回退为空对象', async () => {
  let seenRequest: unknown;
  const transport: GrpcTransport = {
    call: async (_dir, options) => {
      seenRequest = options.request;
      return { status: 'ok', data: {}, durationMs: 1 };
    },
    callServerStream: () => {
      throw new Error('not used');
    },
  };
  await makeRunner(transport).callUnary('NoSuchService', 'Nope', { _raw: '[1,2]' });
  assert.deepEqual(seenRequest, {});
});

test('callUnary: 全限定服务名(pkg.Service)同样命中(CodeLens 入口)', async () => {
  let called = false;
  const transport: GrpcTransport = {
    call: async () => {
      called = true;
      return { status: 'ok', data: {}, durationMs: 1 };
    },
    callServerStream: () => {
      throw new Error('not used');
    },
  };
  const payload = await makeRunner(transport).callUnary('runner.VarService', 'SetVar', { name: 'y' });
  assert.ok(called);
  assert.equal(payload.requestType, 'SetVarRequest');
});

test('callServerStream: 委托给传输层并透传 handlers;cancel 幂等', async () => {
  let cancels = 0;
  let seenHandlers: StreamHandlers | null = null;
  const transport: GrpcTransport = {
    call: () => Promise.reject(new Error('not used')),
    callServerStream: (_dir, _opts, handlers) => {
      seenHandlers = handlers;
      return { cancel: () => cancels++ };
    },
  };
  const runner = makeRunner(transport);
  const handle = runner.callServerStream('VarService', 'SetVar', {}, {
    onData: () => {},
    onError: () => {},
    onEnd: () => {},
  });

  // findMethod 是异步的,流在微任务后才真正发出;cancel 在此之前也安全
  const { promise, resolve } = Promise.withResolvers<void>();
  process.nextTick(resolve);
  await promise;
  assert.ok(seenHandlers);
  handle.cancel();
  assert.equal(cancels, 1);
});
