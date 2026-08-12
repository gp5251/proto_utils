import * as vscode from 'vscode';
import type { ServiceRegistry, ServicesPayload } from './serviceRegistry';
import type { CallResultPayload, CallRunner } from './callHandler';
import { resolveRunnerConfig as resolveRunnerConfigPure } from './config';
import { generateNonce, renderWorkbenchHtml } from './webviewHtml';

// ---- 消息协议(字段名冻结,只增不改) ----

export type WebviewToWorkbench =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'call'; service: string; method: string; values: Record<string, unknown> }
  | { type: 'callStream'; service: string; method: string; values: Record<string, unknown> }
  | { type: 'cancelStream'; service: string; method: string };

export type WorkbenchToWebview =
  | { type: 'loading' }
  | { type: 'services'; payload: ServicesPayload }
  | { type: 'loadError'; errors: string[] }
  | { type: 'callResult'; payload: CallResultPayload }
  | { type: 'streamChunk'; service: string; method: string; data: unknown }
  | { type: 'streamEnd'; service: string; method: string; durationMs: number }
  | { type: 'prefill'; service: string; method: string };

/** 纯消息路由层与 vscode 之间的最小宿主面;onDispose 可注册多个监听器,测试用 fake 实现。 */
export interface WorkbenchHost {
  postMessage(message: WorkbenchToWebview): void;
  onMessage(listener: (message: unknown) => void): void;
  onDispose(listener: () => void): void;
}

export interface WorkbenchSessionDeps {
  registry: Pick<ServiceRegistry, 'load' | 'invalidate'>;
  runner: CallRunner;
  getConfig(): { server: string; protoDir: string };
}

interface CallTarget {
  service: string;
  method: string;
}

interface ActiveStream {
  cancel(): void;
  startedAt: number;
  active: boolean;
}

function readCallTarget(message: object): CallTarget | null {
  if (!('service' in message) || typeof message.service !== 'string') {
    return null;
  }
  if (!('method' in message) || typeof message.method !== 'string') {
    return null;
  }
  return { service: message.service, method: message.method };
}

function readValues(message: object): Record<string, unknown> {
  if (!('values' in message)) {
    return {};
  }
  const raw: unknown = message.values;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    values[key] = value;
  }
  return values;
}

function toErrorPayload(target: CallTarget, err: unknown, durationMs: number): CallResultPayload {
  const message = err instanceof Error ? err.message : String(err);
  return {
    service: target.service,
    method: target.method,
    requestType: 'unknown',
    responseType: 'unknown',
    fields: [],
    values: {},
    result: { status: 'error', error: message, durationMs },
    resultBody: message,
  };
}

/**
 * 工作台消息路由核心:不 import vscode 运行时值,构造注入 Registry/Runner,可单测。
 * 一个会话对应一个 Webview 面板;面板销毁时 dispose() 取消所有进行中的流。
 */
export class WorkbenchSession {
  private host: WorkbenchHost | null = null;
  private webviewReady = false;
  private loadInFlight = false;
  private pendingPrefill: CallTarget | null = null;
  private readonly streams = new Map<string, ActiveStream>();

  constructor(private readonly deps: WorkbenchSessionDeps) {}

  attach(host: WorkbenchHost): void {
    this.host = host;
    host.onMessage((message: unknown) => {
      void this.dispatch(message);
    });
    host.onDispose(() => {
      this.dispose();
    });
  }

  /** CodeLens 入口:webview 就绪且空闲则直发,否则排队到 services 送达后。重复调用只保留最后一次。 */
  prefill(service: string, method: string): void {
    if (this.webviewReady && !this.loadInFlight) {
      this.send({ type: 'prefill', service, method });
      return;
    }
    this.pendingPrefill = { service, method };
  }

  /** proto 文件变更时由 watcher 触发:invalidate 后重新推送。 */
  async reload(): Promise<void> {
    this.deps.registry.invalidate();
    await this.loadAndSend();
  }

  async dispatch(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      return;
    }
    switch (message.type) {
      case 'ready': {
        this.webviewReady = true;
        await this.loadAndSend();
        this.flushPrefill();
        return;
      }
      case 'refresh': {
        await this.reload();
        this.flushPrefill();
        return;
      }
      case 'call': {
        const target = readCallTarget(message);
        if (!target) {
          return;
        }
        await this.runUnary(target, readValues(message));
        return;
      }
      case 'callStream': {
        const target = readCallTarget(message);
        if (!target) {
          return;
        }
        this.runStream(target, readValues(message));
        return;
      }
      case 'cancelStream': {
        const target = readCallTarget(message);
        if (target) {
          this.cancelStream(target);
        }
        return;
      }
    }
  }

  dispose(): void {
    for (const entry of this.streams.values()) {
      entry.active = false;
      entry.cancel();
    }
    this.streams.clear();
    this.host = null;
  }

  private send(message: WorkbenchToWebview): void {
    if (this.host) {
      this.host.postMessage(message);
    }
  }

  private flushPrefill(): void {
    if (!this.pendingPrefill || !this.webviewReady) {
      return;
    }
    const { service, method } = this.pendingPrefill;
    this.pendingPrefill = null;
    this.send({ type: 'prefill', service, method });
  }

  private async loadAndSend(): Promise<void> {
    this.loadInFlight = true;
    this.send({ type: 'loading' });
    try {
      const { services, errors } = await this.deps.registry.load(this.deps.getConfig().protoDir);
      this.send({ type: 'services', payload: services });
      if (errors.length > 0) {
        this.send({ type: 'loadError', errors });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'loadError', errors: [message] });
    } finally {
      this.loadInFlight = false;
    }
  }

  private async runUnary(target: CallTarget, values: Record<string, unknown>): Promise<void> {
    const startedAt = Date.now();
    try {
      const payload = await this.deps.runner.callUnary(target.service, target.method, values);
      this.send({ type: 'callResult', payload });
    } catch (err) {
      this.send({ type: 'callResult', payload: toErrorPayload(target, err, Date.now() - startedAt) });
    }
  }

  private runStream(target: CallTarget, values: Record<string, unknown>): void {
    const key = `${target.service}.${target.method}`;
    const previous = this.streams.get(key);
    if (previous) {
      previous.active = false;
      previous.cancel();
      this.streams.delete(key);
    }
    const entry: ActiveStream = {
      cancel: () => undefined,
      startedAt: Date.now(),
      active: true,
    };
    try {
      const handle = this.deps.runner.callServerStream(target.service, target.method, values, {
        onData: (data: unknown) => {
          if (entry.active) {
            this.send({ type: 'streamChunk', service: target.service, method: target.method, data });
          }
        },
        onError: (message: string) => {
          if (!entry.active) {
            return;
          }
          entry.active = false;
          this.streams.delete(key);
          this.send({
            type: 'callResult',
            payload: toErrorPayload(target, message, Date.now() - entry.startedAt),
          });
        },
        onEnd: (durationMs: number) => {
          if (!entry.active) {
            return;
          }
          entry.active = false;
          this.streams.delete(key);
          this.send({ type: 'streamEnd', service: target.service, method: target.method, durationMs });
        },
      });
      entry.cancel = () => {
        handle.cancel();
      };
      this.streams.set(key, entry);
    } catch (err) {
      this.send({
        type: 'callResult',
        payload: toErrorPayload(target, err, Date.now() - entry.startedAt),
      });
    }
  }

  private cancelStream(target: CallTarget): void {
    const key = `${target.service}.${target.method}`;
    const entry = this.streams.get(key);
    if (!entry) {
      return;
    }
    entry.active = false;
    this.streams.delete(key);
    entry.cancel();
    this.send({
      type: 'streamEnd',
      service: target.service,
      method: target.method,
      durationMs: Date.now() - entry.startedAt,
    });
  }
}

// ---- vscode 粘合层(以下只在扩展宿主内运行,测试不触达) ----

export type WorkbenchPanelDeps = WorkbenchSessionDeps;

/** 读取 protoUtils.runner.* 配置;protoDir 为空 = 工作区根,相对路径相对 workspace folder。 */
export function resolveRunnerConfig(): { server: string; protoDir: string } {
  const config = vscode.workspace.getConfiguration('protoUtils');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const resolved = resolveRunnerConfigPure((key) => config.get(key), root);
  return { server: resolved.server, protoDir: resolved.protoDir ?? '' };
}

/** 工厂产出:已创建面板的最小面。host 供 session 挂载;reveal 聚焦。 */
export interface ManagedWorkbenchPanel {
  host: WorkbenchHost;
  reveal(): void;
}

/** 面板创建交给工厂:扩展宿主传 createVscodePanelFactory,测试传 fake。 */
export type WorkbenchPanelFactory = () => ManagedWorkbenchPanel;

/** 面板单例:未开则创建,已开则聚焦;面板销毁后下次 reveal 重建。 */
export class WorkbenchPanelManager {
  private active: { panel: ManagedWorkbenchPanel; session: WorkbenchSession } | null = null;

  constructor(
    private readonly deps: WorkbenchPanelDeps,
    private readonly factory: WorkbenchPanelFactory,
  ) {}

  /** 当前会话(面板未开时为 null);供 CodeLens 命令层与测试触达。 */
  get currentSession(): WorkbenchSession | null {
    return this.active?.session ?? null;
  }

  /** extension.ts 的入口:打开/聚焦面板;带 prefill 则排队到 webview 就绪后预选方法。 */
  reveal(prefill?: { service: string; method: string }): void {
    if (!this.active) {
      const panel = this.factory();
      const session = new WorkbenchSession(this.deps);
      session.attach(panel.host);
      panel.host.onDispose(() => {
        this.active = null;
      });
      this.active = { panel, session };
    }
    this.active.panel.reveal();
    if (prefill) {
      this.active.session.prefill(prefill.service, prefill.method);
    }
  }

  /** proto watcher 的热更新入口(替代旧 SSE proto-reload)。面板关闭时也要清缓存——否则关闭期间改了 proto,重开会渲染过期服务列表。 */
  async reload(): Promise<void> {
    this.deps.registry.invalidate();
    if (this.active) {
      await this.active.session.reload();
    }
  }
}

/** 真实 Webview 面板工厂:retainContextWhenHidden 保住表单与结果状态,CSP nonce 每面板随机。 */
export function createVscodePanelFactory(
  extensionUri: vscode.Uri,
  deps: WorkbenchPanelDeps,
): WorkbenchPanelFactory {
  return () => {
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media', 'runner');
    const panel = vscode.window.createWebviewPanel(
      'protoUtils.rpcRunner',
      vscode.l10n.t('RPC Workbench'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      },
    );
    panel.webview.html = renderWorkbenchHtml({
      cspSource: panel.webview.cspSource,
      nonce: generateNonce(),
      stylesUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'runner.css')).toString(),
      runnerScriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'runner.js')).toString(),
      formMappingScriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'formMapping.js')).toString(),
      alpineScriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'alpine.min.js')).toString(),
      server: deps.getConfig().server,
      protoDir: deps.getConfig().protoDir,
    });
    return {
      host: {
        postMessage: (message: WorkbenchToWebview) => {
          void panel.webview.postMessage(message);
        },
        onMessage: (listener: (message: unknown) => void) => {
          panel.webview.onDidReceiveMessage(listener);
        },
        onDispose: (listener: () => void) => {
          panel.onDidDispose(listener);
        },
      },
      reveal: () => {
        panel.reveal();
      },
    };
  };
}
