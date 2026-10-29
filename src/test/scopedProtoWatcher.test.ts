import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ScopedProtoWatcher } from '../scopedProtoWatcher';

interface FakeDisposable {
  dispose(): void;
}

interface FakeWatcher extends FakeDisposable {
  onDidCreate(listener: () => void): void;
  onDidChange(listener: () => void): void;
  onDidDelete(listener: () => void): void;
}

function makeFakeWatcher() {
  const listeners = { create: [] as Array<() => void>, change: [] as Array<() => void>, delete: [] as Array<() => void> };
  const api = {
    disposed: false,
    watcher: {
      onDidCreate: (listener: () => void) => listeners.create.push(listener),
      onDidChange: (listener: () => void) => listeners.change.push(listener),
      onDidDelete: (listener: () => void) => listeners.delete.push(listener),
      dispose: () => {
        api.disposed = true;
      },
    } as FakeWatcher,
    emit(kind: keyof typeof listeners): void {
      if (!api.disposed) listeners[kind].forEach((listener) => listener());
    },
  };
  return api;
}

test('精确 watcher 的创建/修改/删除事件都复用同一个热更新入口', () => {
  const fake = makeFakeWatcher();
  let reloads = 0;
  const scoped = new ScopedProtoWatcher(() => fake.watcher, () => reloads++);

  scoped.sync('D:/outside/a.proto');
  fake.emit('create');
  fake.emit('change');
  fake.emit('delete');

  assert.equal(reloads, 3, '原子保存(create)、普通修改(change)与删除(delete)都必须热更新');
  scoped.dispose();
});

test('作用域重复不变不重建;替换/清除/销毁都释放旧 watcher', () => {
  const created: string[] = [];
  const fakes: Array<ReturnType<typeof makeFakeWatcher>> = [];
  const scoped = new ScopedProtoWatcher((file) => {
    created.push(file);
    const fake = makeFakeWatcher();
    fakes.push(fake);
    return fake.watcher;
  }, () => undefined);

  scoped.sync('D:/outside/a.proto');
  scoped.sync('D:/outside/a.proto');
  assert.deepEqual(created, ['D:/outside/a.proto'], '同一来源重复点击不得重建 watcher');
  assert.equal(fakes[0].disposed, false);

  scoped.sync('D:/outside/b.proto');
  assert.equal(fakes[0].disposed, true, '替换来源必须释放上一个文件的 watcher');
  assert.deepEqual(created, ['D:/outside/a.proto', 'D:/outside/b.proto']);

  scoped.sync(null);
  assert.equal(fakes[1].disposed, true, '清除来源必须释放 watcher');
  scoped.sync('D:/outside/c.proto');
  scoped.dispose();
  assert.equal(fakes[2].disposed, true, '扩展销毁必须释放 watcher');
});

test('扩展装配:目录外来源用精确 RelativePattern,并接入既有防抖重载链', () => {
  const src = fs.readFileSync(path.resolve('src/extension.ts'), 'utf8');
  assert.ok(src.includes('new ScopedProtoWatcher('), 'buildManager 必须创建作用域 watcher');
  assert.ok(
    src.includes('new vscode.RelativePattern(path.dirname(file), path.basename(file))'),
    '必须只监听当前来源文件,不能退化成整个外部目录递归扫描',
  );
  assert.ok(src.includes('onScopeChanged: (file: string | null) => scopedWatcher.sync(file)'), '作用域通知必须接到 watcher');
  assert.ok(src.includes('this.onProtoChanged,'), '文件事件必须复用既有 500ms 防抖入口');
  assert.ok(src.includes('this.context.subscriptions.push(scopedWatcher)'), '扩展销毁时必须释放 watcher');
});
