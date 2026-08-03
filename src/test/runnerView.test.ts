import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RunnerViewProvider, RUNNER_VIEW_ID } from '../runner/runnerView';
import { WorkbenchSession, WorkbenchHost, WorkbenchToWebview } from '../runner/workbenchSession';
import { CallRunner, CallResultPayload } from '../runner/callHandler';
import { ServicesPayload } from '../runner/serviceRegistry';
import { Uri, commands } from 'vscode';

// stub 专有字段(真实 vscode.commands 没有),经具名常量读取,避免每次内联断言
const commandLog: string[] = (commands as unknown as { log: string[] }).log;

/** fake WebviewView:记录 html/options/出站消息,可模拟入站与销毁 */
function makeView(visible = true) {
  const posted: WorkbenchToWebview[] = [];
  const listeners: Array<(m: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const view = {
    visible,
    webview: {
      options: {} as Record<string, unknown>,
      html: '',
      cspSource: 'vscode-webview://test',
      asWebviewUri: (u: { toString(): string }) => ({
        toString: () => `webview-uri:${u.toString()}`,
        with: () => ({ toString: () => `webview-uri:${u.toString()}?v=1` }),
      }),
      postMessage: (m: WorkbenchToWebview) => {
        posted.push(m);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (l: (m: unknown) => void) => listeners.push(l),
    },
    onDidDispose: (l: () => void) => disposeListeners.push(l),
  };
  return {
    view,
    posted,
    emit: (m: unknown) => listeners.forEach((l) => l(m)),
    dispose: () => disposeListeners.forEach((l) => l()),
  };
}

const SERVICES: ServicesPayload = [{ name: 'Greeter', fullName: 'c.Greeter', methods: [] }];

function makeSession(): WorkbenchSession {
  const runner: Partial<CallRunner> = {
    callUnary: async () => ({ result: { status: 'ok' } }) as CallResultPayload,
  };
  return new WorkbenchSession({
    registry: { load: async () => ({ services: SERVICES, errors: [] }), invalidate: () => {} },
    runner: runner as CallRunner,
    getConfig: () => ({ server: 'test:1', protoDir: 'D:/protos' }),
  });
}

function makeProvider(visible = true) {
  const fakes = makeView(visible);
  const provider = new RunnerViewProvider(Uri.file('/ext'), async () => makeSession());
  return { provider, ...fakes };
}

beforeEach(() => {
  commandLog.length = 0;
});

test('resolveWebviewView:渲染 HTML 并配置脚本与媒体根', async () => {
  const { provider, view } = makeProvider();
  provider.resolveWebviewView(view as never);
  assert.ok(view.webview.html.includes('RPC 工作台'));
  assert.ok((view.webview.options as { enableScripts?: boolean }).enableScripts);
  await Promise.resolve();
});

test('会话到达并 attach 后,ready 驱动 loading→services', async () => {
  const { provider, view, posted, emit } = makeProvider();
  provider.resolveWebviewView(view as never);
  await new Promise((r) => setImmediate(r));
  emit({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    posted.map((m) => m.type),
    ['loading', 'services'],
  );
});

test('showCallTarget:会话已就绪时直接 prefill,并聚焦视图', async () => {
  const { provider, view, posted, emit } = makeProvider();
  provider.resolveWebviewView(view as never);
  await new Promise((r) => setImmediate(r));
  emit({ type: 'ready' });
  await new Promise((r) => setImmediate(r));

  await provider.showCallTarget({ service: 'c.Greeter', method: 'SayHello' });
  assert.deepEqual(commandLog, [`${RUNNER_VIEW_ID}.focus`]);
  assert.equal(posted[posted.length - 1].type, 'prefill');
});

test('showCallTarget:会话未就绪时挂起,会话到达后补发 prefill', async () => {
  const { provider, view, posted, emit } = makeProvider();
  const showPromise = provider.showCallTarget({ service: 'c.Greeter', method: 'Subscribe' });
  provider.resolveWebviewView(view as never);
  await showPromise;
  await new Promise((r) => setImmediate(r));
  emit({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  assert.ok(posted.some((m) => m.type === 'prefill' && 'service' in m && m.service === 'c.Greeter'));
});

test('followCallTarget:视图不可见时 no-op;可见时 prefill;同目标去重', async () => {
  const hidden = makeProvider(false);
  hidden.provider.followCallTarget({ service: 'c.Greeter', method: 'SayHello' });
  assert.equal(hidden.posted.length, 0);

  const { provider, view, posted, emit } = makeProvider(true);
  provider.resolveWebviewView(view as never);
  await new Promise((r) => setImmediate(r));
  emit({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  const baseline = posted.length;

  provider.followCallTarget({ service: 'c.Greeter', method: 'SayHello' });
  provider.followCallTarget({ service: 'c.Greeter', method: 'SayHello' });
  assert.equal(posted.length, baseline + 1);
});

test('dispose 后视图与会话清空,isVisible 变 false', async () => {
  const { provider, view, dispose } = makeProvider();
  provider.resolveWebviewView(view as never);
  await new Promise((r) => setImmediate(r));
  assert.ok(provider.isVisible);
  dispose();
  assert.equal(provider.isVisible, false);
});

test('会话工厂 reject:错误进 loadError,不停在 boot 态', async () => {
  const fakes = makeView();
  const provider = new RunnerViewProvider(Uri.file('/ext'), () => Promise.reject(new Error('grpc bundle missing')));
  provider.resolveWebviewView(fakes.view as never);
  await new Promise((r) => setImmediate(r));
  const loadError = fakes.posted.find((m) => m.type === 'loadError');
  assert.ok(loadError);
  if (loadError?.type === 'loadError') assert.match(loadError.errors[0], /grpc bundle missing/);
});

test('视图销毁后才到达的会话被 dispose,不 attach 不重放 pending', async () => {
  let disposed = 0;
  const fakes = makeView();
  const provider = new RunnerViewProvider(Uri.file('/ext'), async () => {
    const session = makeSession();
    const originalDispose = session.dispose.bind(session);
    session.dispose = () => {
      disposed++;
      originalDispose();
    };
    return session;
  });
  provider.resolveWebviewView(fakes.view as never);
  fakes.dispose();
  await new Promise((r) => setImmediate(r));
  assert.equal(disposed, 1);
  assert.equal(fakes.posted.length, 0);
});
