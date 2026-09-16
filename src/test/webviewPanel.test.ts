import { test, mock } from 'node:test';
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

/** 探测是 fire-and-forget 旁路,与 load 主链无时序约定:轮询等目标消息落定(有界防挂死) */
async function untilPosted(posted: WorkbenchToWebview[], type: string): Promise<WorkbenchToWebview | undefined> {
  for (let i = 0; i < 50; i++) {
    const hit = posted.find((m) => m.type === type);
    if (hit) {
      return hit;
    }
    await new Promise((r) => setImmediate(r));
  }
  return undefined;
}

const SERVICES: ServicesPayload = [{ name: 'Greeter', fullName: 'c.Greeter', methods: [] }];

function makeDeps(overrides: {
  loadResult?: { services: ServicesPayload; errors: string[] };
  loadError?: Error;
  runner?: Partial<CallRunner>;
  onLoadSettled?: () => void;
  probeConnection?: () => Promise<boolean>;
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
    ...(overrides.onLoadSettled ? { onLoadSettled: overrides.onLoadSettled } : {}),
    ...(overrides.probeConnection ? { probeConnection: overrides.probeConnection } : {}),
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

test('loadError 携带与 errors 对齐的 segments(出错点分段);抛异常路径同约', async () => {
  const errorsCase = makeHost();
  new WorkbenchSession(
    makeDeps({ loadResult: { services: [], errors: ['bad.proto: no such type: demo.v1.MissingReq'] } }).deps,
  ).attach(errorsCase.host);
  errorsCase.emit({ type: 'ready' });
  await nextTick();
  const loadError = errorsCase.posted.find((m) => m.type === 'loadError') as {
    errors: string[];
    segments?: Array<Array<{ text: string; spot?: string }>>;
  };
  assert.ok(loadError.segments, 'errors 路径必须带 segments');
  assert.equal(loadError.segments.length, loadError.errors.length, 'segments 与 errors 逐条对齐');
  const segs = loadError.segments[0];
  assert.equal(segs.map((s) => s.text).join(''), 'bad.proto: no such type: demo.v1.MissingReq', '分段拼回原文');
  assert.ok(
    segs.some((s) => s.spot === 'type' && s.text === 'demo.v1.MissingReq'),
    '缺失类型名标 type 出错点',
  );
  assert.ok(segs.some((s) => s.spot === 'file' && s.text === 'bad.proto'), '文件前缀标 file 出错点');

  const throwCase = makeHost();
  new WorkbenchSession(makeDeps({ loadError: new Error('parse blew up') }).deps).attach(throwCase.host);
  throwCase.emit({ type: 'ready' });
  await nextTick();
  const thrown = throwCase.posted.find((m) => m.type === 'loadError') as { segments?: unknown[][] };
  assert.ok(thrown.segments && thrown.segments.length === 1, 'catch 路径同样带 segments');
});

test('onLoadSettled:成功/部分错误/抛错三种结局各回调一次', async () => {
  const scenarios: Array<{
    loadResult?: { services: ServicesPayload; errors: string[] };
    loadError?: Error;
  }> = [{}, { loadResult: { services: [], errors: ['e1'] } }, { loadError: new Error('boom') }];
  for (const overrides of scenarios) {
    let settled = 0;
    const { host, emit } = makeHost();
    new WorkbenchSession(makeDeps({ ...overrides, onLoadSettled: () => settled++ }).deps).attach(host);
    emit({ type: 'ready' });
    await nextTick();
    assert.equal(settled, 1, '每次 loadAndSend 恰好回调一次');
  }
});

test('未注入 onLoadSettled 时加载照常(可选依赖)', async () => {
  const { host, posted, emit } = makeHost();
  new WorkbenchSession(makeDeps().deps).attach(host);
  emit({ type: 'ready' });
  await nextTick();
  assert.deepEqual(posted.map((m) => m.type), ['loading', 'services']);
});

test('连通性探测(0.3.54):ready/refresh 各探测一次,可达 ok/不可达 fail/抛错 fail', async () => {
  // 可达 → ok;refresh 重探一次
  let probes = 0;
  const okCase = makeHost();
  new WorkbenchSession(makeDeps({ probeConnection: async () => { probes++; return true; } }).deps).attach(okCase.host);
  okCase.emit({ type: 'ready' });
  assert.deepEqual(await untilPosted(okCase.posted, 'connState'), { type: 'connState', state: 'ok' });
  assert.equal(probes, 1);
  okCase.emit({ type: 'refresh' });
  // refresh 的 services 与首发同型,不能靠 untilPosted 区分;直接等探测计数落定
  for (let i = 0; i < 50 && probes < 2; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(probes, 2, 'refresh 必须重探(后端可能刚上下线)');

  // 不可达与探测抛错(TLS 配置错等)同报 fail
  for (const probeConnection of [async () => false, async () => { throw new Error('tls cfg'); }]) {
    const c = makeHost();
    new WorkbenchSession(makeDeps({ probeConnection }).deps).attach(c.host);
    c.emit({ type: 'ready' });
    assert.deepEqual(await untilPosted(c.posted, 'connState'), { type: 'connState', state: 'fail' });
  }
});

test('未注入 probeConnection 时不发 connState(状态点保持未知态)', async () => {
  const { host, posted, emit } = makeHost();
  new WorkbenchSession(makeDeps().deps).attach(host);
  emit({ type: 'ready' });
  await nextTick();
  assert.ok(!posted.some((m) => m.type === 'connState'));
});

test('探测失败每 5s 自动重探(0.3.56):持续 fail 持续重探,恢复 ok 即停', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  let calls = 0;
  // fail → fail → ok:验证重探排期与恢复停止
  const outcomes = [false, false, true];
  const probeConnection = async () => outcomes[Math.min(calls++, outcomes.length - 1)];
  const { host, posted, emit } = makeHost();
  new WorkbenchSession(makeDeps({ probeConnection }).deps).attach(host);

  emit({ type: 'ready' });
  assert.deepEqual(await untilPosted(posted, 'connState'), { type: 'connState', state: 'fail' });
  assert.equal(calls, 1);

  // 4.9s 未到点不重探,5s 到点自动重探第二次(仍 fail → 再排一次)
  mock.timers.tick(4900);
  await nextTick();
  assert.equal(calls, 1, '未到 5s 不得提前重探');
  mock.timers.tick(200);
  // tick 内同步发起 probe(calls 已递增),但 send/再排期在 promise 续体——先刷一轮微任务再断言
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, '5s 到点必须自动重探');

  // 第三次转 ok:此后不再排期
  mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 3);
  assert.deepEqual(posted[posted.length - 1], { type: 'connState', state: 'ok' });
  mock.timers.tick(20000);
  await nextTick();
  assert.equal(calls, 3, '恢复后不得再重探');
});

test('面板销毁后不再自动重探(dispose 清定时器)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  let calls = 0;
  const { host, emit, dispose } = makeHost();
  new WorkbenchSession(
    makeDeps({
      probeConnection: async () => {
        calls++;
        return false;
      },
    }).deps,
  ).attach(host);
  emit({ type: 'ready' });
  for (let i = 0; i < 50 && calls < 1; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(calls, 1);

  dispose();
  mock.timers.tick(20000);
  await nextTick();
  assert.equal(calls, 1, 'dispose 后不得再重探');
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

test('loadAndSend 并发合并:in-flight 期间第二次请求塌缩为一次补跑(0.3.48)', async () => {
  const { host, emit } = makeHost();
  const { deps } = makeDeps();
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  let loadCalls = 0;
  const gates: Array<() => void> = [];
  // 可控 gate:每次 load 卡到手动放行,制造 in-flight 窗口
  deps.registry.load = () => {
    loadCalls++;
    return new Promise<{ services: ServicesPayload; errors: string[] }>((resolve) => {
      gates.push(() => resolve({ services: SERVICES, errors: [] }));
    });
  };
  const session = new WorkbenchSession(deps);
  session.attach(host);

  emit({ type: 'ready' }); // 首次 load,卡在 gates[0]
  await settle();
  emit({ type: 'refresh' }); // in-flight 期间第二次:合并为 reloadQueued,不并发发起
  await settle();
  assert.equal(loadCalls, 1, 'in-flight 期间不得并发第二次 load');

  gates[0](); // 放行首次 → 收尾后补跑一次,卡在 gates[1]
  await settle();
  assert.equal(loadCalls, 2, '当前 load 收尾后补跑恰好一次(多次请求塌缩)');

  gates[1](); // 放行补跑 → 无排队,不再 load
  await settle();
  assert.equal(loadCalls, 2, '无排队请求时不再重复 load');
});
