import * as vscode from 'vscode';
import type { ServiceRegistry, ServicesPayload } from './serviceRegistry';
import type { CallResultPayload, CallRunner } from './callHandler';
import type { MetadataEntry, TlsSettings } from './config';
import { resolveRunnerConfig as resolveRunnerConfigPure } from './config';
import { generateNonce, renderWorkbenchHtml, renderWorkbenchLoadingHtml } from './webviewHtml';
import { parseProtoError, type ErrorSegment } from '../protoErrorMessage';

// ---- 消息协议(字段名冻结,只增不改;0.3.40 loadError 增 segments) ----

export type WebviewToWorkbench =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'call'; service: string; method: string; values: Record<string, unknown>; metadata?: MetadataEntry[] }
  | { type: 'callStream'; service: string; method: string; values: Record<string, unknown>; metadata?: MetadataEntry[] }
  | { type: 'cancelStream'; service: string; method: string };

export type WorkbenchToWebview =
  | { type: 'loading' }
  | { type: 'services'; payload: ServicesPayload }
  /** segments 与 errors 逐条对齐:出错点分段(spot 非空渲染波浪线);缺省由 webview 退化为整行纯文本段 */
  | { type: 'loadError'; errors: string[]; segments?: ErrorSegment[][] }
  | { type: 'callResult'; payload: CallResultPayload }
  | { type: 'streamChunk'; service: string; method: string; data: unknown }
  | { type: 'streamHeaders'; service: string; method: string; headers: MetadataEntry[] }
  | { type: 'streamTrailers'; service: string; method: string; trailers: MetadataEntry[] }
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
  getConfig(): { server: string; protoDir: string; metadata: MetadataEntry[] };
  /** 0.3.40:proto 加载尘埃落定(成功/部分错误/抛错)后回调,activation 侧借此补诊断飘红。可选,测试不受影响。 */
  onLoadSettled?(): void;
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

/** 仿 readValues:只收 {key:string, value:string} 项,其余丢弃。 */
function readMetadata(message: object): MetadataEntry[] {
  if (!('metadata' in message)) {
    return [];
  }
  const raw: unknown = message.metadata;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: MetadataEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const { key, value } = item as { key?: unknown; value?: unknown };
    if (typeof key === 'string' && typeof value === 'string') {
      out.push({ key, value });
    }
  }
  return out;
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
        await this.runUnary(target, readValues(message), readMetadata(message));
        return;
      }
      case 'callStream': {
        const target = readCallTarget(message);
        if (!target) {
          return;
        }
        this.runStream(target, readValues(message), readMetadata(message));
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
        this.send({ type: 'loadError', errors, segments: errors.map((e) => parseProtoError(e).segments) });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'loadError', errors: [message], segments: [parseProtoError(message).segments] });
    } finally {
      this.loadInFlight = false;
      // 诊断平面补充触发:runner 只发信号不解释错误串(ADR-0002 单语义解析器),
      // activation 侧重跑 ProtoFrontend 得出与保存路径一致的飘红
      this.deps.onLoadSettled?.();
    }
  }

  private async runUnary(target: CallTarget, values: Record<string, unknown>, metadata: MetadataEntry[]): Promise<void> {
    const startedAt = Date.now();
    try {
      const payload = await this.deps.runner.callUnary(target.service, target.method, values, metadata);
      this.send({ type: 'callResult', payload });
    } catch (err) {
      this.send({ type: 'callResult', payload: toErrorPayload(target, err, Date.now() - startedAt) });
    }
  }

  private runStream(target: CallTarget, values: Record<string, unknown>, metadata: MetadataEntry[]): void {
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
        onHeaders: (headers: MetadataEntry[]) => {
          if (entry.active) {
            this.send({ type: 'streamHeaders', service: target.service, method: target.method, headers });
          }
        },
        onTrailers: (trailers: MetadataEntry[]) => {
          if (entry.active) {
            this.send({ type: 'streamTrailers', service: target.service, method: target.method, trailers });
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
      }, metadata);
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


/** 读取 protoUtils.runner.* 全量配置;protoDir 为空 = 工作区根,相对路径相对 workspace folder。 */
export function resolveRunnerConfig(): {
  server: string;
  protoDir: string;
  tls: TlsSettings;
  metadata: MetadataEntry[];
  timeoutMs: number;
} {
  const config = vscode.workspace.getConfiguration('protoUtils');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const resolved = resolveRunnerConfigPure((key) => config.get(key), root);
  return {
    server: resolved.server,
    protoDir: resolved.protoDir ?? '',
    tls: resolved.tls,
    metadata: resolved.metadata,
    timeoutMs: resolved.timeoutMs,
  };
}

/** 活动栏视图容器 / WebviewView 标识,与 package.json contributes 声明一致。 */
export const WORKBENCH_VIEW_ID = 'protoUtils.rpcRunner';

/** 视图首次解析的同步打底:设置 options 并渲染 loading 壳,grpc bundle 懒加载完成前视图不空白。 */
export function primeWorkbenchView(view: vscode.WebviewView, extensionUri: vscode.Uri): void {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media', 'runner');
  view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
  view.webview.html = renderWorkbenchLoadingHtml({
    stylesUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'runner.css')).toString(),
  });
}

/** 侧边栏 WebviewView 粘合层:一个 view 解析对应一个会话。视图隐藏不销毁
 *  (retainContextWhenHidden 由注册侧声明),销毁即弃会话,下次解析重建。 */
export class WorkbenchViewManager implements vscode.WebviewViewProvider {
  private session: WorkbenchSession | null = null;
  private pendingPrefill: CallTarget | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: WorkbenchSessionDeps,
  ) {}

  /** 当前会话(视图未解析/已销毁时为 null);供测试触达。 */
  get currentSession(): WorkbenchSession | null {
    return this.session;
  }

  /** 打开/聚焦侧边栏视图;会话未建立时 prefill 排队到首次解析。 */
  reveal(prefill?: CallTarget): void {
    if (prefill) {
      if (this.session) {
        this.session.prefill(prefill.service, prefill.method);
      } else {
        this.pendingPrefill = prefill;
      }
    }
    void vscode.commands.executeCommand(`${WORKBENCH_VIEW_ID}.focus`);
  }

  /** proto watcher 的热更新入口。缓存失效由 LazyWorkbench 无条件先行,此处仅重推在挂会话。 */
  async reload(): Promise<void> {
    await this.session?.reload();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media', 'runner');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = renderWorkbenchHtml({
      cspSource: view.webview.cspSource,
      nonce: generateNonce(),
      stylesUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'runner.css')).toString(),
      runnerScriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'runner.js')).toString(),
      formMappingScriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'formMapping.js')).toString(),
      resultTreeScriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'resultTree.js')).toString(),
      alpineScriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'alpine.min.js')).toString(),
      server: this.deps.getConfig().server,
      protoDir: this.deps.getConfig().protoDir,
      metadataDefault: this.deps.getConfig().metadata,
    });
    const session = new WorkbenchSession(this.deps);
    this.session = session;
    session.attach({
      postMessage: (message) => {
        void view.webview.postMessage(message);
      },
      onMessage: (listener) => {
        view.webview.onDidReceiveMessage(listener);
      },
      onDispose: (listener) => {
        view.onDidDispose(listener);
      },
    });
    view.onDidDispose(() => {
      if (this.session === session) {
        this.session = null;
      }
    });
    const prefill = this.pendingPrefill;
    this.pendingPrefill = null;
    if (prefill) {
      session.prefill(prefill.service, prefill.method);
    }
  }
}
