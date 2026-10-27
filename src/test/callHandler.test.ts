import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GrpcCallRunner, GrpcTransport } from '../runner/callHandler';
import { ServiceRegistry } from '../runner/serviceRegistry';
import { CallResult, StreamHandlers } from '../runner/core/types';

/**
 * callHandler 的 spec 契约测试:注入 fake GrpcClient 工厂,
 * 覆盖 成功载荷组装 / 调用错误 / 非法 JSON _raw 回退 / 流式委托与取消 /
 * 配置每次调用现读(server/protoDir/TLS/超时改动即时生效)。
 */

const RUNNER_DIR = path.resolve('testdata/runner');

const NO_TLS = { enabled: false, rootCert: null, clientCert: null, clientKey: null };

function staticConfig(protoDir: string = RUNNER_DIR) {
  return { server: 'fake:0', protoDir, tls: NO_TLS, timeoutMs: 0 };
}

function makeRunner(transport: GrpcTransport): GrpcCallRunner {
  return new GrpcCallRunner(() => staticConfig(), new ServiceRegistry(), () => transport);
}

test('callUnary: 每次调用现读配置——server/protoDir 改动即时生效', async () => {
  const seen: Array<{ addr: string; dir: string }> = [];
  let cfg = staticConfig();
  const runner = new GrpcCallRunner(
    () => cfg,
    new ServiceRegistry(),
    (c) => ({
      call: async (dir) => {
        seen.push({ addr: c.server, dir });
        return { status: 'ok', data: {}, durationMs: 1 };
      },
      callServerStream: () => {
        throw new Error('not used');
      },
    }),
  );

  await runner.callUnary('NoSuchService', 'Nope', {});
  cfg = staticConfig(path.resolve('testdata'));
  cfg = { ...cfg, server: 'b:2' };
  await runner.callUnary('NoSuchService', 'Nope', {});

  assert.deepEqual(seen, [
    { addr: 'fake:0', dir: RUNNER_DIR },
    { addr: 'b:2', dir: path.resolve('testdata') },
  ]);
});

test('callServerStream: 同样现读配置,启动后改动不影响进行中的流(快照语义)', async () => {
  const seen: Array<{ addr: string; dir: string }> = [];
  let cfg = staticConfig();
  const runner = new GrpcCallRunner(
    () => cfg,
    new ServiceRegistry(),
    (c) => ({
      call: () => Promise.reject(new Error('not used')),
      callServerStream: (dir, _opts, handlers) => {
        seen.push({ addr: c.server, dir });
        handlers.onEnd(0);
        return { cancel: () => undefined };
      },
    }),
  );

  const handle = runner.callServerStream('VarService', 'WatchVars', {}, {
    onData: () => {},
    onError: () => {},
    onEnd: () => {},
  });
  // 启动即改配置:流必须沿用调用发起时的快照,findMethod 落地后不得重读
  cfg = { ...cfg, server: 'b:2' };

  // findMethod 是异步的,流在微任务后才真正发出
  const { promise, resolve } = Promise.withResolvers<void>();
  process.nextTick(resolve);
  await promise;
  assert.deepEqual(seen, [{ addr: 'fake:0', dir: RUNNER_DIR }]);
  handle.cancel();
});

test('callUnary: metadata 透传进 CallOptions;callServerStream 同理', async () => {
  const seen: Array<unknown> = [];
  const transport: GrpcTransport = {
    call: async (_dir, options) => {
      seen.push(options.metadata);
      return { status: 'ok', data: {}, durationMs: 1 };
    },
    callServerStream: (_dir, options, handlers) => {
      seen.push(options.metadata);
      handlers.onEnd(0);
      return { cancel: () => undefined };
    },
  };
  const runner = makeRunner(transport);
  const md = [{ key: 'x-token', value: 'abc' }];
  await runner.callUnary('VarService', 'SetVar', { index: '1' }, md);
  runner.callServerStream('VarService', 'WatchVars', {}, { onData: () => {}, onError: () => {}, onEnd: () => {} }, md);
  const { promise: tick, resolve: ticked } = Promise.withResolvers<void>();
  process.nextTick(ticked);
  await tick;
  assert.deepEqual(seen, [md, md]);
});

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

test('callUnary: ok 载荷携带响应 headers/trailers;错误载荷缺省', async () => {
  const okTransport: GrpcTransport = {
    call: async () => ({
      status: 'ok',
      data: {},
      durationMs: 1,
      responseHeaders: [{ key: 'x-h', value: '1' }],
      responseTrailers: [{ key: 'x-t', value: '2' }],
    }),
    callServerStream: () => {
      throw new Error('not used');
    },
  };
  const okPayload = await makeRunner(okTransport).callUnary('VarService', 'SetVar', {});
  assert.deepEqual(okPayload.responseHeaders, [{ key: 'x-h', value: '1' }]);
  assert.deepEqual(okPayload.responseTrailers, [{ key: 'x-t', value: '2' }]);

  const errTransport: GrpcTransport = {
    call: async () => ({ status: 'error', error: 'boom', durationMs: 1 }),
    callServerStream: () => {
      throw new Error('not used');
    },
  };
  const errPayload = await makeRunner(errTransport).callUnary('VarService', 'SetVar', {});
  assert.equal(errPayload.responseHeaders, undefined);
  assert.equal(errPayload.responseTrailers, undefined);
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

test('callUnary: _raw 接受 JSON5(注释/裸键名/尾逗号)', async () => {
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
  await makeRunner(transport).callUnary('NoSuchService', 'Nope', { _raw: '{ // c\na: 1,\n}' });
  assert.deepEqual(seenRequest, { a: 1 });
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

// ---- 钉住文件贯通调用面(0.3.83):CodeLens 点击的目录外 proto 也要能调 ----

const PINNED_ALPHA = path.resolve('testdata/dupsvc/alpha.proto');

test('GrpcCallRunner 默认工厂透传 registry.pinnedFiles:解析越过「Service not found」进到连接阶段', async () => {
  const registry = new ServiceRegistry();
  registry.pin(PINNED_ALPHA, RUNNER_DIR);
  // 不注入 clientFactory → 走默认工厂(真实 GrpcClient)。服务定义解析发生在建连之前,
  // 故 server 指向必然连不上的端口也能区分「钉住有没有透传」。
  const runner = new GrpcCallRunner(() => ({ ...staticConfig(), server: '127.0.0.1:1' }), registry);
  const payload = await runner.callUnary('alpha.Echo', 'Send', {});

  assert.equal(payload.requestType, 'EchoReq', '服务列表侧:钉住文件的方法 schema 应已解析');
  assert.equal(payload.result.status, 'error');
  assert.ok(
    !/not found in proto definitions/.test(payload.result.error ?? ''),
    `调用侧应已解析到定义文件,错误该来自连接阶段,实际:${payload.result.error}`,
  );
});

test('grpcurlCommand(0.3.83):钉住的目录外服务给出可执行的 -import-path/-proto,而非 ../..', async () => {
  const registry = new ServiceRegistry();
  registry.pin(PINNED_ALPHA, RUNNER_DIR);
  const runner = new GrpcCallRunner(() => staticConfig(), registry, () => {
    throw new Error('grpcurl 不经过传输层');
  });

  const cmd = await runner.grpcurlCommand('alpha.Echo', 'Send', { name: 'x' });
  // 定义文件在 protoDir 之外:相对化会产出 ..\dupsvc\alpha.proto 这类粘不进去的路径,
  // 必须改用文件自身目录作 -import-path + 裸文件名作 -proto,命令才可直接执行。
  assert.ok(!cmd.includes('..'), `不该出现 ../.. 的相对路径:\n${cmd}`);
  assert.match(cmd, /-import-path (?:'[^']*dupsvc'|[^\s]*dupsvc)/, `import-path 应指向 dupsvc:\n${cmd}`);
  assert.match(cmd, /-proto '?alpha\.proto'?/, `proto 应为裸文件名:\n${cmd}`);
  assert.match(cmd, /alpha\.Echo\/Send/, '服务/方法全限定名不变');
});
