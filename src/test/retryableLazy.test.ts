import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryableLazy } from '../retryableLazy';

/**
 * RetryableLazy 的契约测试:单例缓存 + 失败即弃。
 * 对应 extension.ts LazyWorkbench 的懒加载语义:动态 import/依赖构建一旦失败,
 * 不得把 rejected promise 永久缓存毒化后续打开——必须可重试。
 */

test('get: 成功后复用同一实例,工厂只跑一次', async () => {
  let calls = 0;
  const lazy = new RetryableLazy(async () => {
    calls++;
    return { id: calls };
  });
  const first = await lazy.get();
  const second = await lazy.get();
  assert.equal(calls, 1);
  assert.equal(first, second);
});

test('get: 未启动前 started 为 false,get 后为 true', async () => {
  const lazy = new RetryableLazy(async () => 'x');
  assert.equal(lazy.started, false);
  await lazy.get();
  assert.equal(lazy.started, true);
});

test('get: 并发调用共享同一次工厂', async () => {
  let calls = 0;
  const lazy = new RetryableLazy(
    () => new Promise<number>((resolve) => setTimeout(() => resolve(++calls), 5)),
  );
  const [a, b] = await Promise.all([lazy.get(), lazy.get()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('get: 失败即弃——下次 get 重新构建并成功(不毒化)', async () => {
  let calls = 0;
  const lazy = new RetryableLazy(async () => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return `ok-${calls}`;
  });
  await assert.rejects(() => lazy.get(), /boom/);
  assert.equal(await lazy.get(), 'ok-2');
  assert.equal(calls, 2);
});

test('get: 失败后 started 归 false,可重新进入首次路径', async () => {
  const lazy = new RetryableLazy<string>(async () => {
    throw new Error('always');
  });
  await assert.rejects(() => lazy.get(), /always/);
  assert.equal(lazy.started, false);
});
