import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkbenchSession,
  WorkbenchHost,
  WorkbenchToWebview,
  WorkbenchPanelManager,
} from '../runner/webviewPanel';
import { CallRunner, CallResultPayload } from '../runner/callHandler';
import { ServicesPayload } from '../runner/serviceRegistry';
import { StreamHandlers } from '../runner/core/types';

/** 记录出站消息、可模拟入站消息与销毁事件的 fake host */
function makeHost() {
  const posted: WorkbenchToWebview[] = [];
  const listeners: Array<(message: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const host: WorkbenchHost = {
    postMessage: (m) => posted.push(m),
    onMessage: (l) => listeners.push(l),
    onDispose: (l) => disposeListeners.push(l),
  };
  return {
    host,
    posted,
    emit: (m: unknown) => listeners.forEach((l) => l(m)),
    dispose: () => disposeListeners.forEach((l) => l()),
  };
}

/** 等一个微任务回合,让 dispatch 里的 async 链跑完 */
function nextTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  process.nextTick(resolve);
  return promise;
}

const SERVICES: ServicesPayload = [{ name: 'Greeter', fullName: 'c.Greeter', methods: [] }];

function makeDeps(overrides: {
  loadResult?: { services: ServicesPayload; errors: string[] };
  loadError?: Error;
  runner?: Partial<CallRunner>;
} = {}) {
  const state = { invalidated: 0, protoDir: 'D:/protos' };
  const deps = {
    registry: {
      load: async (_protoDir: string) => {
        if (overrides.loadError) throw overrides.loadError;
        return overrides.loadResult ?? { services: SERVICES, errors: [] };
      },
      invalidate: () => {
        state.invalidated++;
      },
    },
    runner: {
      callUnary: async () => {
        throw new Error('not stubbed');
      },
      callServerStream: () => {
        throw new Error('not stubbed');
      },
      ...overrides.runner,
    } as CallRunner,
    getConfig: () => ({ server: 'localhost:50051', protoDir: state.protoDir, metadata: [] }),
  };
  return { deps, state };
}

test('ready → loading 后推 services;protoDir 来自 getConfig', async () => {
  const { host, posted, emit } = makeHost();
  const { deps } = makeDeps();
  let seenDir = '';
  const originalLoad = deps.registry.load;
  deps.registry.load = async (dir: string) => {
    seenDir = dir;
    return originalLoad(dir);
  };
  new WorkbenchSession(deps).attach(host);
  emit({ type: 'ready' });
  await nextTick();

  assert.deepEqual(seenDir, 'D:/protos');
  assert.deepEqual(posted.map((m) => m.type), ['loading', 'services']);
  assert.equal((posted[1] as { payload: ServicesPayload }).payload, SERVICES);
});

test('registry 报错 → services 照推 + loadError;load 抛异常 → 仅 loadError', async () => {
  const withErrors = makeHost();
  new WorkbenchSession(makeDeps({ loadResult: { services: [], errors: ['bad.proto: boom'] } }).deps).attach(withErrors.host);
  withErrors.emit({ type: 'ready' });
  await nextTick();
  assert.deepEqual(
    withErrors.posted.map((m) => m.type),
    ['loading', 'services', 'loadError'],
  );

  const throwing = makeHost();
  new WorkbenchSession(makeDeps({ loadError: new Error('parse blew up') }).deps).attach(throwing.host);
  throwing.emit({ type: 'ready' });
  await nextTick();
  assert.deepEqual(
    throwing.posted.map((m) => m.type),
    ['loading', 'loadError'],
  );
});

test('call/callStream 的 metadata 经 sanitize 后透传给 runner(只收 {key,value} 字符串项)', async () => {
  const seen: Array<unknown> = [];
  const runner: Partial<CallRunner> = {
    callUnary: async (_s, _m, _v, metadata) => {
      seen.push(metadata);
      return { result: { status: 'ok' } } as CallResultPayload;
    },
    callServerStream: (_s, _m, _v, _h, metadata) => {
      seen.push(metadata);
      return { cancel: () => undefined };
    },
  };
  const { host, emit } = makeHost();
  new WorkbenchSession(makeDeps({ runner }).deps).attach(host);
  emit({
    type: 'call',
    service: 'c.Greeter',
    method: 'SayHello',
    values: {},
    metadata: [{ key: 'x-token', value: 'abc' }, { key: 1, value: 'x' }, { key: 'no-value' }, 'junk', null],
  });
  await nextTick();
  emit({
    type: 'callStream',
    service: 'c.Greeter',
    method: 'Subscribe',
    values: {},
    metadata: 'not-an-array',
  });
  await nextTick();
  assert.deepEqual(seen, [[{ key: 'x-token', value: 'abc' }], []]);
});

test('call → callResult;runner 抛异常 → error payload', async () => {  const okPayload = { result: { status: 'ok' } } as CallResultPayload;
  const ok = makeHost();
  new WorkbenchSession(makeDeps({ runner: { callUnary: async () => okPayload } }).deps).attach(ok.host);
  ok.emit({ type: 'call', service: 'c.Greeter', method: 'SayHello', values: {} });
  await nextTick();
  assert.equal((ok.posted[0] as { payload: CallResultPayload }).payload, okPayload);

  const failing = makeHost();
  const runner: Partial<CallRunner> = {
    callUnary: async () => {
      throw new Error('connection refused');
    },
  };
  new WorkbenchSession(makeDeps({ runner }).deps).attach(failing.host);
  failing.emit({ type: 'call', service: 'c.Greeter', method: 'SayHello', values: {} });
  await nextTick();
  const payload = (failing.posted[0] as { payload: CallResultPayload }).payload;
  assert.equal(payload.result.status, 'error');
  if (payload.result.status === 'error') assert.equal(payload.result.error, 'connection refused');
});

test('callStream → streamChunk×N → streamEnd;cancelStream 取消并收尾', async () => {
  const { host, posted, emit } = makeHost();
  let handlers: StreamHandlers | null = null;
  let cancelled = 0;
  const runner: Partial<CallRunner> = {
    callServerStream: (_s, _m, _v, h) => {
      handlers = h;
      return { cancel: () => cancelled++ };
    },
  };
  new WorkbenchSession(makeDeps({ runner }).deps).attach(host);

  emit({ type: 'callStream', service: 'c.Greeter', method: 'Subscribe', values: {} });
  assert.ok(handlers);
  // handlers 在回调里赋值,TS 跟踪不到;assert.ok 是运行时守卫,cast 只为过编译
  const streamHandlers = handlers as StreamHandlers;
  streamHandlers.onData({ nums: [1] });
  streamHandlers.onData({ nums: [2] });
  streamHandlers.onEnd(12);

  assert.deepEqual(
    posted.map((m) => m.type),
    ['streamChunk', 'streamChunk', 'streamEnd'],
  );
  assert.equal((posted[2] as { durationMs: number }).durationMs, 12);

  // 再开一条流然后由 webview 取消:cancel 被调、streamEnd 收尾
  posted.length = 0;
  emit({ type: 'callStream', service: 'c.Greeter', method: 'Subscribe', values: {} });
  emit({ type: 'cancelStream', service: 'c.Greeter', method: 'Subscribe' });
  assert.equal(cancelled, 1);
  assert.deepEqual(posted.map((m) => m.type), ['streamEnd']);
});

test('callStream: onHeaders/onTrailers 转发为 streamHeaders/streamTrailers 消息', async () => {
  const { host, posted, emit } = makeHost();
  let handlers: StreamHandlers | null = null;
  const runner: Partial<CallRunner> = {
    callServerStream: (_s, _m, _v, h) => {
      handlers = h;
      return { cancel: () => undefined };
    },
  };
  new WorkbenchSession(makeDeps({ runner }).deps).attach(host);

  emit({ type: 'callStream', service: 'c.Greeter', method: 'Subscribe', values: {} });
  assert.ok(handlers);
  const streamHandlers = handlers as StreamHandlers;
  const headers = [{ key: 'x-h', value: '1' }];
  const trailers = [{ key: 'x-t', value: '2' }];
  streamHandlers.onHeaders?.(headers);
  streamHandlers.onData({ nums: [1] });
  streamHandlers.onTrailers?.(trailers);
  streamHandlers.onEnd(9);

  assert.deepEqual(
    posted.map((m) => m.type),
    ['streamHeaders', 'streamChunk', 'streamTrailers', 'streamEnd'],
  );
  assert.equal((posted[0] as { headers: unknown }).headers, headers);
  assert.equal((posted[2] as { trailers: unknown }).trailers, trailers);
});

test('流错误进 callResult;dispose 取消进行中的流', async () => {
  const { host, posted, emit, dispose } = makeHost();
  let handlers: StreamHandlers | null = null;
  let cancelled = 0;
  const runner: Partial<CallRunner> = {
    callServerStream: (_s, _m, _v, h) => {
      handlers = h;
      return { cancel: () => cancelled++ };
    },
  };
  new WorkbenchSession(makeDeps({ runner }).deps).attach(host);

  emit({ type: 'callStream', service: 'c.Greeter', method: 'Watch', values: {} });
  assert.ok(handlers);
  (handlers as StreamHandlers).onError('UNAVAILABLE: gone');
  const payload = (posted[0] as { payload: CallResultPayload }).payload;
  assert.equal(payload.result.status, 'error');
  if (payload.result.status === 'error') assert.match(payload.result.error, /UNAVAILABLE/);

  posted.length = 0;
  emit({ type: 'callStream', service: 'c.Greeter', method: 'Watch', values: {} });
  dispose();
  assert.equal(cancelled, 1);
  assert.equal(posted.length, 0);
});

test('prefill 在 ready 前排队,services 送达后按序冲出;就绪后直发', async () => {
  const { host, posted, emit } = makeHost();
  const session = new WorkbenchSession(makeDeps().deps);
  session.attach(host);

  session.prefill('c.Greeter', 'Subscribe');
  emit({ type: 'ready' });
  await nextTick();
  assert.deepEqual(
    posted.map((m) => m.type),
    ['loading', 'services', 'prefill'],
  );

  session.prefill('c.Greeter', 'SayHello');
  const last = posted[posted.length - 1];
  assert.deepEqual(last, { type: 'prefill', service: 'c.Greeter', method: 'SayHello' });
});

test('refresh → invalidate 后重载并推 services', async () => {
  const { host, posted, emit } = makeHost();
  const { deps, state } = makeDeps();
  new WorkbenchSession(deps).attach(host);
  emit({ type: 'refresh' });
  await nextTick();
  assert.equal(state.invalidated, 1);
  assert.deepEqual(
    posted.map((m) => m.type),
    ['loading', 'services'],
  );
});

test('面板单例:两次 reveal 只建一次,销毁后重建', () => {
  let created = 0;
  let revealed = 0;
  const disposers: Array<() => void> = [];
  const { deps } = makeDeps();
  const manager = new WorkbenchPanelManager(deps, () => {
    created++;
    const { host, dispose } = makeHost();
    disposers.push(dispose);
    return { host, reveal: () => revealed++ };
  });

  manager.reveal();
  manager.reveal();
  assert.equal(created, 1);
  // 每次 manager.reveal 都聚焦现有面板
  assert.equal(revealed, 2);

  // 面板销毁后下次 reveal 重建
  disposers[0]();
  manager.reveal();
  assert.equal(created, 2);

  // prefill 委托给当前会话
  manager.reveal({ service: 'c.Greeter', method: 'SayHello' });
  assert.ok(manager.currentSession);
});

test('面板关闭后 reload 仍清缓存,重开不渲染过期服务列表', async () => {
  const disposers: Array<() => void> = [];
  const { deps, state } = makeDeps();
  const manager = new WorkbenchPanelManager(deps, () => {
    const { host, dispose } = makeHost();
    disposers.push(dispose);
    return { host, reveal: () => {} };
  });

  manager.reveal();
  disposers[0](); // 关闭面板 → active = null
  assert.equal(manager.currentSession, null);

  // watcher 在面板关闭期间触发:缓存必须失效,否则重开吃到旧 services
  await manager.reload();
  assert.equal(state.invalidated, 1);
});
