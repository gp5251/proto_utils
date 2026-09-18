import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SequenceRunner, type SequenceEvent } from '../runner/sequence';
import type { CallRunner, CallResultPayload } from '../runner/callHandler';
import type { CallResult, StreamHandlers } from '../runner/core/types';
import type { SerializedMethod, SerializedService } from '../runner/serviceRegistry';
import type { Sequence } from '../runner/sequenceStore';
import type { MetadataEntry } from '../runner/config';

/** 构造最小 SerializedService(校验只看 name/fullName/methods[].name)。 */
function svc(name: string, ...methods: string[]): SerializedService {
  const ms: SerializedMethod[] = methods.map((m) => ({
    name: m,
    requestType: 'Req',
    responseType: 'Res',
    requestStream: false,
    responseStream: false,
    requestFields: [],
    responseSchemaRows: [],
  }));
  return { name, fullName: `pkg.${name}`, methods: ms };
}

/** 可编程 fake CallRunner:一元按 respond 脚本返回,流暴露 handlers 供测试驱动。 */
class FakeRunner implements CallRunner {
  unary: Array<{ service: string; method: string; values: Record<string, unknown> }> = [];
  streamCalls: Array<{ service: string; method: string; values: Record<string, unknown> }> = [];
  lastStreamHandlers: StreamHandlers | null = null;
  cancelCount = 0;

  constructor(private readonly respond: (service: string, method: string, values: Record<string, unknown>) => CallResult) {}

  async callUnary(service: string, method: string, values: Record<string, unknown>): Promise<CallResultPayload> {
    this.unary.push({ service, method, values });
    const result = this.respond(service, method, values);
    return {
      service,
      method,
      requestType: 'Req',
      responseType: 'Res',
      fields: [],
      values: {},
      result,
      resultBody: result.status === 'ok' ? JSON.stringify(result.data) : result.error,
    };
  }

  callServerStream(service: string, method: string, values: Record<string, unknown>, handlers: StreamHandlers): { cancel(): void } {
    this.streamCalls.push({ service, method, values });
    this.lastStreamHandlers = handlers;
    return {
      cancel: () => {
        this.cancelCount++;
        // 模拟真实 grpc:取消以 CANCELLED 错误收场
        handlers.onError('CANCELLED');
      },
    };
  }
}

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function harness(services: SerializedService[], respond: FakeRunner['respond'] = () => ({ status: 'ok', data: {}, durationMs: 1 })) {
  const fake = new FakeRunner(respond);
  const events: SequenceEvent[] = [];
  const runner = new SequenceRunner({
    runner: fake,
    registry: { load: async () => ({ services, errors: [] }) },
    getConfig: () => ({ protoDir: 'x', metadata: [] }),
    onEvent: (e) => events.push(e),
  });
  const types = () => events.map((e) => e.type);
  return { fake, events, runner, types };
}

const ok = (data: unknown): CallResult => ({ status: 'ok', data, durationMs: 1 });

test('运行前整体校验:任一步方法失效 → validationFailed + aborted,不发起任何调用', async () => {
  const { fake, runner, events } = harness([svc('Auth', 'Login')]);
  const seq: Sequence = {
    name: 's',
    steps: [
      { service: 'Auth', method: 'Login', mode: 'form', responseStream: false },
      { service: 'Auth', method: 'Ghost', mode: 'form', responseStream: false },
    ],
  };
  await runner.run(seq);
  const vf = events.find((e) => e.type === 'validationFailed');
  assert.ok(vf && vf.type === 'validationFailed');
  assert.deepEqual(vf.missing, [{ index: 1, service: 'Auth', method: 'Ghost' }]);
  assert.deepEqual(events[events.length - 1], { type: 'end', status: 'aborted' });
  assert.equal(fake.unary.length, 0);
});

test('一元链式:后步占位符吃到前步响应,依序完成', async () => {
  const { fake, runner, types } = harness([svc('Auth', 'Login', 'Get')], (_s, m) =>
    m === 'Login' ? ok({ token: 'abc' }) : ok({ done: true }),
  );
  const seq: Sequence = {
    name: 's',
    steps: [
      { service: 'Auth', method: 'Login', mode: 'form', values: {}, responseStream: false },
      { service: 'Auth', method: 'Get', mode: 'form', values: { t: '{{step0.data.token}}' }, responseStream: false },
    ],
  };
  await runner.run(seq);
  assert.deepEqual(fake.unary[1].values, { t: 'abc' }, '占位符已解析');
  assert.deepEqual(types(), ['stepStart', 'stepUnaryResult', 'stepStart', 'stepUnaryResult', 'end']);
  assert.equal(fake.unary.length, 2);
});

test('首个失败步即中止:一元 gRPC 错误 → aborted,后续不跑', async () => {
  const { fake, runner, events } = harness([svc('A', 'X', 'Y')], (_s, m) =>
    m === 'X' ? { status: 'error', error: 'UNAVAILABLE', durationMs: 1 } : ok({}),
  );
  await runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'X', mode: 'form', responseStream: false },
      { service: 'A', method: 'Y', mode: 'form', responseStream: false },
    ],
  });
  assert.equal(fake.unary.length, 1, 'Y 未发起');
  assert.deepEqual(events[events.length - 1], { type: 'end', status: 'aborted' });
});

test('占位符取空 → stepFailed + aborted,该步不发起调用', async () => {
  const { fake, runner, events } = harness([svc('A', 'X', 'Y')], () => ok({}));
  await runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'X', mode: 'form', responseStream: false },
      { service: 'A', method: 'Y', mode: 'form', values: { t: '{{step0.data.nope}}' }, responseStream: false },
    ],
  });
  assert.equal(fake.unary.length, 1);
  assert.ok(events.some((e) => e.type === 'stepFailed' && e.index === 1));
  assert.deepEqual(events[events.length - 1], { type: 'end', status: 'aborted' });
});

test('json 模式:JSON5 解析 + 占位符解析后作为 values', async () => {
  const { fake, runner } = harness([svc('A', 'X', 'Y')], (_s, m) => (m === 'X' ? ok({ id: 5 }) : ok({})));
  await runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'X', mode: 'form', responseStream: false },
      { service: 'A', method: 'Y', mode: 'json', jsonText: '{ uid: "{{step0.data.id}}", name: "x", }', responseStream: false },
    ],
  });
  assert.deepEqual(fake.unary[1].values, { uid: 5, name: 'x' });
});

test('json 非法 → stepFailed', async () => {
  const { runner, events } = harness([svc('A', 'X')]);
  await runner.run({
    name: 's',
    steps: [{ service: 'A', method: 'X', mode: 'json', jsonText: '{bad', responseStream: false }],
  });
  assert.ok(events.some((e) => e.type === 'stepFailed'));
  assert.deepEqual(events[events.length - 1], { type: 'end', status: 'aborted' });
});

test('流步骤:chunks 累积,自然结束后可被下一步按索引引用', async () => {
  const { fake, runner, types } = harness([svc('A', 'Watch', 'Y')], () => ok({}));
  const p = runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'Watch', mode: 'form', responseStream: true },
      { service: 'A', method: 'Y', mode: 'form', values: { x: '{{step0.chunks[1].data.id}}' }, responseStream: false },
    ],
  });
  await waitFor(() => fake.lastStreamHandlers !== null);
  fake.lastStreamHandlers!.onData({ id: 1 });
  fake.lastStreamHandlers!.onData({ id: 2 });
  fake.lastStreamHandlers!.onEnd(5);
  await p;
  assert.deepEqual(fake.unary[0].values, { x: 2 });
  assert.equal(types().filter((t) => t === 'stepChunk').length, 2);
  assert.deepEqual(fake.streamCalls.length, 1);
  assert.deepEqual(types()[types().length - 1], 'end');
});

test('流步骤出错(非手动)→ aborted', async () => {
  const { fake, runner, events } = harness([svc('A', 'Watch', 'Y')], () => ok({}));
  const p = runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'Watch', mode: 'form', responseStream: true },
      { service: 'A', method: 'Y', mode: 'form', responseStream: false },
    ],
  });
  await waitFor(() => fake.lastStreamHandlers !== null);
  fake.lastStreamHandlers!.onError('boom');
  await p;
  const se = events.find((e) => e.type === 'stepStreamEnd');
  assert.ok(se && se.type === 'stepStreamEnd' && se.ok === false && se.error === 'boom');
  assert.equal(fake.unary.length, 0);
  assert.deepEqual(events[events.length - 1], { type: 'end', status: 'aborted' });
});

test('手动结束流步骤 → 视作成功并继续下一步', async () => {
  const { fake, runner, events } = harness([svc('A', 'Watch', 'Y')], () => ok({}));
  const p = runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'Watch', mode: 'form', responseStream: true },
      { service: 'A', method: 'Y', mode: 'form', responseStream: false },
    ],
  });
  await waitFor(() => fake.lastStreamHandlers !== null);
  runner.endCurrentStream();
  await p;
  assert.equal(fake.cancelCount, 1);
  const se = events.find((e) => e.type === 'stepStreamEnd');
  assert.ok(se && se.type === 'stepStreamEnd' && se.ok === true, '手动结束算成功');
  assert.equal(fake.unary.length, 1, '下一步照跑');
  assert.deepEqual(events[events.length - 1], { type: 'end', status: 'completed' });
});

test('stop() 停止整条:当前流步骤收尾后不再推进,end=stopped', async () => {
  const { fake, runner, events } = harness([svc('A', 'Watch', 'Y')], () => ok({}));
  const p = runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'Watch', mode: 'form', responseStream: true },
      { service: 'A', method: 'Y', mode: 'form', responseStream: false },
    ],
  });
  await waitFor(() => fake.lastStreamHandlers !== null);
  runner.stop();
  await p;
  assert.equal(fake.unary.length, 0, '后续步未跑');
  assert.deepEqual(events[events.length - 1], { type: 'end', status: 'stopped' });
});

/** cancel 不回任何事件的传输层(复现真实 grpc 取消后无 onEnd/onError 的卡死场景)。 */
class SilentCancelRunner implements CallRunner {
  unary: Array<{ service: string; method: string; values?: Record<string, unknown>; metadata?: MetadataEntry[] }> = [];
  lastStreamHandlers: StreamHandlers | null = null;
  cancelCount = 0;
  async callUnary(service: string, method: string, values: Record<string, unknown>, metadata?: MetadataEntry[]): Promise<CallResultPayload> {
    this.unary.push({ service, method, values, metadata });
    return {
      service, method, requestType: 'Req', responseType: 'Res', fields: [], values: {},
      result: ok({}), resultBody: '{}',
    };
  }
  callServerStream(service: string, method: string, _v: Record<string, unknown>, handlers: StreamHandlers): { cancel(): void } {
    this.lastStreamHandlers = handlers;
    return { cancel: () => { this.cancelCount++; /* 故意不回事件 */ } };
  }
}

test('回归:传输层 cancel 不回事件时,手动结束仍立即推进(不卡“接收中”)', async () => {
  const fake = new SilentCancelRunner();
  const events: SequenceEvent[] = [];
  const runner = new SequenceRunner({
    runner: fake,
    registry: { load: async () => ({ services: [svc('A', 'Watch', 'Y')], errors: [] }) },
    getConfig: () => ({ protoDir: 'x', metadata: [] }),
    onEvent: (e) => events.push(e),
  });
  const p = runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'Watch', mode: 'form', responseStream: true },
      { service: 'A', method: 'Y', mode: 'form', responseStream: false },
    ],
  });
  await waitFor(() => fake.lastStreamHandlers !== null);
  runner.endCurrentStream();
  await p; // 若引擎被动等传输层回执,这里会永远挂起
  assert.equal(fake.cancelCount, 1);
  const se = events.find((e) => e.type === 'stepStreamEnd');
  assert.ok(se && se.type === 'stepStreamEnd' && se.ok === true);
  assert.equal(fake.unary.length, 1, '手动结束后必须推进到下一步');
  assert.deepEqual(events[events.length - 1], { type: 'end', status: 'completed' });
  // 收尾后底层流残留数据不得再上报(0.3.62):否则报告区继续 churn 观感“没停”
  const chunksBefore = events.filter((e) => e.type === 'stepChunk').length;
  fake.lastStreamHandlers!.onData({ late: true });
  assert.equal(events.filter((e) => e.type === 'stepChunk').length, chunksBefore, '收尾后残留 chunk 不得上报');
});

test('回归:传输层 cancel 不回事件时,stop() 仍能终止(end=stopped)', async () => {
  const fake = new SilentCancelRunner();
  const events: SequenceEvent[] = [];
  const runner = new SequenceRunner({
    runner: fake,
    registry: { load: async () => ({ services: [svc('A', 'Watch', 'Y')], errors: [] }) },
    getConfig: () => ({ protoDir: 'x', metadata: [] }),
    onEvent: (e) => events.push(e),
  });
  const p = runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'Watch', mode: 'form', responseStream: true },
      { service: 'A', method: 'Y', mode: 'form', responseStream: false },
    ],
  });
  await waitFor(() => fake.lastStreamHandlers !== null);
  runner.stop();
  await p;
  assert.equal(fake.unary.length, 0);
  assert.deepEqual(events[events.length - 1], { type: 'end', status: 'stopped' });
});

test('序列流 chunk 上限即接收上限(0.3.63):收满自动结束该步并推进+取消底层流,不再多收', async () => {
  const fake = new SilentCancelRunner();
  const events: SequenceEvent[] = [];
  const runner = new SequenceRunner({
    runner: fake,
    registry: { load: async () => ({ services: [svc('A', 'Watch', 'Y')], errors: [] }) },
    getConfig: () => ({ protoDir: 'x', metadata: [] }),
    onEvent: (e) => events.push(e),
  });
  const p = runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'Watch', mode: 'form', responseStream: true, maxMessages: 2 },
      { service: 'A', method: 'Y', mode: 'form', values: { first: '{{step0.chunks[0].data.n}}' }, responseStream: false },
    ],
  });
  await waitFor(() => fake.lastStreamHandlers !== null);
  fake.lastStreamHandlers!.onData({ n: 1 });
  fake.lastStreamHandlers!.onData({ n: 2 }); // 收满 → 自动结束并推进,无需 onEnd
  await p;
  assert.equal(fake.cancelCount, 1, '收满须取消底层流');
  assert.deepEqual(fake.unary[0].values, { first: 1 }, '已收 chunk 全保留,chunks[0] = 第一条');
  const se = events.find((e) => e.type === 'stepStreamEnd');
  assert.equal(se && (se as { chunkCount?: number }).chunkCount, 2, 'chunkCount = 实收条数');
  // 收尾后底层残留不再上报/计入
  const before = events.filter((e) => e.type === 'stepChunk').length;
  fake.lastStreamHandlers!.onData({ n: 3 });
  assert.equal(events.filter((e) => e.type === 'stepChunk').length, before, '收尾后残留 chunk 不得上报');
});

test('序列流 chunk 上限 0 = 不限(0.3.63):全部保留,占位符可引最早块', async () => {
  const fake = new SilentCancelRunner();
  const events: SequenceEvent[] = [];
  const runner = new SequenceRunner({
    runner: fake,
    registry: { load: async () => ({ services: [svc('A', 'Watch', 'Y')], errors: [] }) },
    getConfig: () => ({ protoDir: 'x', metadata: [] }),
    onEvent: (e) => events.push(e),
  });
  const p = runner.run({
    name: 's',
    steps: [
      { service: 'A', method: 'Watch', mode: 'form', responseStream: true, maxMessages: 0 },
      { service: 'A', method: 'Y', mode: 'form', values: { first: '{{step0.chunks[0].data.n}}' }, responseStream: false },
    ],
  });
  await waitFor(() => fake.lastStreamHandlers !== null);
  for (let n = 1; n <= 5; n++) fake.lastStreamHandlers!.onData({ n });
  fake.lastStreamHandlers!.onEnd(1);
  await p;
  assert.deepEqual(fake.unary[0].values, { first: 1 }, '0=不限时最早块仍可引用');
});

test('步级 metadata 按 key 合并全局(0.3.64):同 key 步级优先,异 key 追加,全局顺序保持', async () => {
  const fake = new SilentCancelRunner();
  const runner = new SequenceRunner({
    runner: fake,
    registry: { load: async () => ({ services: [svc('A', 'Y')], errors: [] }) },
    getConfig: () => ({ protoDir: 'x', metadata: [{ key: 'auth', value: 'global' }, { key: 'trace', value: 'g' }] }),
    onEvent: () => {},
  });
  await runner.run({
    name: 's',
    steps: [
      {
        service: 'A', method: 'Y', mode: 'form', responseStream: false,
        metadata: [{ key: 'auth', value: 'step' }, { key: 'extra', value: 'e' }],
      },
    ],
  });
  assert.deepEqual(fake.unary[0].metadata, [
    { key: 'auth', value: 'step' },
    { key: 'trace', value: 'g' },
    { key: 'extra', value: 'e' },
  ]);
});
