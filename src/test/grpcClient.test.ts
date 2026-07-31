import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { GrpcClient } from '../runner/core/grpcClient';

/**
 * GrpcClient 的行为测试:对 in-process grpc-js Server 发真实 loopback 调用。
 * 覆盖 resolveMethod 的缩写防护(keepCase:false 下 ListFBVariableRequest 的
 * stub 键是 listFbVariableRequest,朴素首字母小写会失配)、ADR-0007 服务端流、
 * 以及错误路径。不设活体外部服务。
 */

const FRONTEND_DIR = path.resolve('testdata/frontend');

let server: grpc.Server;
let client: GrpcClient;

type UnaryImpl = (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => void;
type StreamImpl = (call: grpc.ServerWritableStream<unknown, unknown>) => void;

/** 以 proto 声明名建 impl,按 originalName 挂到 grpc-js 期望的键上 */
function buildHandlers(
  def: grpc.ServiceDefinition,
  impls: Record<string, UnaryImpl | StreamImpl>,
): grpc.UntypedServiceImplementation {
  const handlers: grpc.UntypedServiceImplementation = {};
  for (const [protoName, methodDef] of Object.entries(def)) {
    const impl = impls[protoName];
    if (impl) handlers[methodDef.originalName ?? protoName] = impl;
  }
  return handlers;
}

before(async () => {
  const pkgDef = protoLoader.loadSync(
    [path.join(FRONTEND_DIR, 'sub', 'user.proto'), path.join(FRONTEND_DIR, 'sub', 'acronym.proto')],
    { keepCase: false, longs: Number, enums: Number, defaults: true, oneofs: true, includeDirs: [FRONTEND_DIR] },
  );
  const grpcObj = grpc.loadPackageDefinition(pkgDef) as unknown as Record<string, Record<string, grpc.ServiceClientConstructor>>;

  server = new grpc.Server();
  server.addService(
    grpcObj.c.Greeter.service,
    buildHandlers(grpcObj.c.Greeter.service, {
      SayHello: (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => {
        const req = call.request as { nums?: number[] };
        if (req.nums?.includes(999)) {
          cb({ code: grpc.status.INVALID_ARGUMENT, details: 'bad nums' } as grpc.ServiceError, null);
          return;
        }
        cb(null, call.request);
      },
      Subscribe: (call: grpc.ServerWritableStream<unknown, unknown>) => {
        for (const n of [1, 2, 3]) call.write({ nums: [n] });
        call.end();
      },
    }),
  );
  server.addService(
    grpcObj.c.Acronym.service,
    buildHandlers(grpcObj.c.Acronym.service, {
      ListFBVariableRequest: (_call, cb) => cb(null, { names: ['fb1', 'fb2'] }),
      WatchFBVariable: (call: grpc.ServerWritableStream<unknown, unknown>) => {
        // 写一块后永不主动 end:只为 cancel 测试提供「活着但不结束」的流,无需定时器
        call.write({ names: ['tick'] });
      },
    }),
  );

  const { promise: bound, resolve: resolveBind, reject: rejectBind } = Promise.withResolvers<number>();
  server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => {
    if (err) rejectBind(err);
    else resolveBind(p);
  });
  const port = await bound;
  server.start();
  client = new GrpcClient(`127.0.0.1:${port}`);
});

after(() => {
  server.forceShutdown();
});

test('unary roundtrip through the full resolveCall chain', async () => {
  const result = await client.call(FRONTEND_DIR, {
    service: 'Greeter',
    method: 'SayHello',
    request: { nums: [7] },
  });
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.deepEqual((result.data as { nums: number[] }).nums, [7]);
});

test('acronym method resolves via case-insensitive fallback, not naive lowercase', async () => {
  // naiveKey = listFBVariableRequest;grpc-js stub 键 = listFbVariableRequest。
  // 若 resolveMethod 退化为朴素首字母小写,这里会报 method not found。
  const result = await client.call(FRONTEND_DIR, {
    service: 'Acronym',
    method: 'ListFBVariableRequest',
    request: { fbName: 'x' },
  });
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.deepEqual((result.data as { names: string[] }).names, ['fb1', 'fb2']);
});

test('unknown service reports not-found error', async () => {
  const result = await client.call(FRONTEND_DIR, { service: 'Nope', method: 'M', request: {} });
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /not found in proto definitions/);
});

test('unknown method error lists available methods', async () => {
  const result = await client.call(FRONTEND_DIR, { service: 'Greeter', method: 'Nope', request: {} });
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /Available:/);
});

test('callUnary refuses client-streaming methods with a clear error', async () => {
  const result = await client.call(FRONTEND_DIR, {
    service: 'Acronym',
    method: 'UploadFBData',
    request: {},
  });
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /客户端流方法/);
});

test('callUnary refuses server-streaming methods and points at the stream API', async () => {
  const result = await client.call(FRONTEND_DIR, {
    service: 'Acronym',
    method: 'WatchFBVariable',
    request: {},
  });
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /服务端流方法/);
});

test('server-streaming delivers every chunk then onEnd with a duration', async () => {
  const chunks: unknown[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  client.callServerStream(
    FRONTEND_DIR,
    { service: 'Greeter', method: 'Subscribe', request: {} },
    {
      onData: (data) => chunks.push(data),
      onError: (message) => reject(new Error(message)),
      onEnd: resolve,
    },
  );
  const durationMs = await promise;
  assert.equal(chunks.length, 3);
  assert.ok(durationMs >= 0);
});

test('callServerStream rejects unary methods', async () => {
  const { promise, resolve } = Promise.withResolvers<string>();
  client.callServerStream(
    FRONTEND_DIR,
    { service: 'Greeter', method: 'SayHello', request: {} },
    { onData: () => {}, onError: resolve, onEnd: () => resolve('unexpected end') },
  );
  const message = await promise;
  assert.match(message, /不是服务端流方法/);
});

test('cancel stops a server stream and reports a normal end, not an error', async () => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  // 真实墙钟超时:集成防护,只在 cancel 实现坏掉(流永不 settle)时触发,不参与正确性时序
  const timer = setTimeout(() => reject(new Error('cancel did not settle the stream in 3s')), 3000);
  const handle = client.callServerStream(
    FRONTEND_DIR,
    { service: 'Acronym', method: 'WatchFBVariable', request: {} },
    {
      onData: () => handle.cancel(),
      onError: (message) => {
        clearTimeout(timer);
        reject(new Error(`cancel surfaced as error: ${message}`));
      },
      onEnd: () => {
        clearTimeout(timer);
        resolve('ended');
      },
    },
  );
  const outcome = await promise;
  assert.equal(outcome, 'ended');
});

test('server-side INVALID_ARGUMENT surfaces as formatted error text', async () => {
  const result = await client.call(FRONTEND_DIR, {
    service: 'Greeter',
    method: 'SayHello',
    request: { nums: [999] },
  });
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /INVALID_ARGUMENT/);
});
