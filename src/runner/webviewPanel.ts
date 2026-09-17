import * as vscode from 'vscode';
import type { ServiceRegistry, ServicesPayload } from './serviceRegistry';
import type { CallResultPayload, CallRunner } from './callHandler';
import type { MetadataEntry, TlsSettings } from './config';
import { SequenceRunner, type SequenceEvent } from './sequence';
import { parseSequence, type Sequence, type SequenceStore } from './sequenceStore';
import { resolveRunnerConfig as resolveRunnerConfigPure } from './config';
import { generateNonce, renderWorkbenchHtml } from './webviewHtml';
import { parseProtoError, type ErrorSegment } from '../protoErrorMessage';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- 消息协议(字段名冻结,只增不改;0.3.40 loadError 增 segments;0.3.54 增 connState) ----

export type WebviewToWorkbench =
  | { type: 'ready' }
  | { type: 'refresh' }
  /** 0.3.62:仅重探连接/服务可达性,不 invalidate/不重解析 proto;结果经 connState 回推。 */
  | { type: 'refreshServices' }
  | { type: 'call'; service: string; method: string; values: Record<string, unknown>; metadata?: MetadataEntry[] }
  | { type: 'callStream'; service: string; method: string; values: Record<string, unknown>; metadata?: MetadataEntry[] }
  | { type: 'cancelStream'; service: string; method: string }
  // ---- 调用序列(0.3.59,ADR-0012) ----
  /** 跑一条工作序列(sequence 为未信任入站,经 parseSequence 校验)。 */
  | { type: 'runSequence'; sequence: Sequence }
  /** 停止整条序列(取消当前步 + 丢弃后续)。 */
  | { type: 'stopSequence' }
  /** 手动结束当前流步骤并继续下一步(双通道推进)。 */
  | { type: 'endSequenceStream' }
  | { type: 'listSequences' }
  | { type: 'saveSequence'; sequence: Sequence }
  | { type: 'loadSequence'; name: string }
  | { type: 'deleteSequence'; name: string };

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
  | { type: 'prefill'; service: string; method: string }
  /** 顶栏连接状态点:ok=通道可达,fail=不可达/超时/配置错(0.3.54) */
  | { type: 'connState'; state: 'ok' | 'fail' }
  // ---- 调用序列(0.3.59,ADR-0012) ----
  /** 已存命名序列列表(存/删后重推)。 */
  | { type: 'sequences'; list: Sequence[] }
  /** 加载结果:null = 未找到。 */
  | { type: 'sequenceLoaded'; sequence: Sequence | null }
  /** 持久化/序列非法错误(损坏文件、无工作区、空名等)。 */
  | { type: 'sequenceStoreError'; message: string }
  /** 引擎逐步事件包一层转发:webview 按 event.type 路由到序列报告。 */
  | { type: 'seqEvent'; event: SequenceEvent };

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
  /** 0.3.54:后端连通性探测(顶栏状态点数据源);未注入则状态点保持未知态,不发 connState。 */
  probeConnection?(): Promise<boolean>;
  /** 0.3.59:命名序列持久化(ADR-0012);未注入(如无工作区)则存/载/删降级为不可用。 */
  store?: SequenceStore;
}

/** 探测失败后的自动重探间隔(0.3.56):后端重启后状态点自动转绿、按钮自动解禁,免手动刷新。 */
const PROBE_RETRY_MS = 5000;

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
  /** loadInFlight 期间到来的重载请求塌缩为此标志,当前 load 收尾后补跑一次(0.3.48)。 */
  private reloadQueued = false;
  private pendingPrefill: CallTarget | null = null;
  private readonly streams = new Map<string, ActiveStream>();
  /** 自动重探定时器;同一时刻至多一个,dispose 时清除。 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 进行中的序列引擎;同一时刻至多一条,run 收尾后清空(0.3.59)。 */
  private activeSequence: SequenceRunner | null = null;
  /** dispose 后不再发送/排期:防 in-flight 探测在 dispose 续体里复活定时器(zombie 心跳,0.3.62 周期复探引入)。 */
  private disposed = false;

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
      case 'refreshServices': {
        // 0.3.62 刷新服务:只发一次探测(毫秒级),不动 proto 缓存与服务列表;
        // 探测恒推 connState,webview 据此收尾手动探测态并给回执通知
        void this.probe();
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
      case 'runSequence': {
        this.startSequence((message as { sequence?: unknown }).sequence);
        return;
      }
      case 'stopSequence': {
        this.activeSequence?.stop();
        return;
      }
      case 'endSequenceStream': {
        this.activeSequence?.endCurrentStream();
        return;
      }
      case 'listSequences': {
        await this.listSequences();
        return;
      }
      case 'saveSequence': {
        await this.saveSequence((message as { sequence?: unknown }).sequence);
        return;
      }
      case 'loadSequence': {
        const name = (message as { name?: unknown }).name;
        if (typeof name === 'string') {
          await this.loadSequence(name);
        }
        return;
      }
      case 'deleteSequence': {
        const name = (message as { name?: unknown }).name;
        if (typeof name === 'string') {
          await this.deleteSequence(name);
        }
        return;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRetry();
    this.activeSequence?.stop();
    this.activeSequence = null;
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
    // 并发合并(0.3.48 性能):一次 load 进行中时,新的 ready/refresh/reload 请求
    // 不再并发发起第二次全量解析,只置 reloadQueued;当前 load 收尾后补跑一次
    // (多次请求塌缩为「当前 + 至多一次补跑」),避免批量 proto 变更时反复重解析。
    if (this.loadInFlight) {
      this.reloadQueued = true;
      return;
    }
    this.loadInFlight = true;
    this.send({ type: 'loading' });
    // 连通性探测走旁路:不阻塞 load 主链,结果异步推 connState。
    // 挂在 loadAndSend 一个点,ready/refresh/watcher 重载全覆盖。
    void this.probe();
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
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.loadAndSend();
      }
    }
  }

  /** 探测失败与抛错同报 fail(不可达/超时/TLS 配置错);未注入依赖则静默(状态点停未知态)。
   *  每 5s 周期复探(0.3.56 起仅失败重探;0.3.62 改为可达也周期复探),后端上下线都在一个
   *  周期内反映到状态点;探测现读配置,server 改动自动生效。 */
  private async probe(): Promise<void> {
    if (!this.deps.probeConnection) {
      return;
    }
    let reachable = false;
    try {
      reachable = await this.deps.probeConnection();
    } catch {
      reachable = false;
    }
    // 关闭瞬间探测在途:续体醒来时 session 已销毁,不得再发送/排期(否则 zombie 5s 心跳)
    if (this.disposed) {
      return;
    }
    this.send({ type: 'connState', state: reachable ? 'ok' : 'fail' });
    // 可达也排下一次:周期复探不区分结局,仅 dispose 停表
    this.scheduleRetry();
  }

  /** 排下一次周期复探;同一时刻至多一个定时器(并发探测不重复排期)。 */
  private scheduleRetry(): void {
    if (this.retryTimer) {
      return; // 并发探测只排一次
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.probe();
    }, PROBE_RETRY_MS);
    // 不挡进程退出:测试环境 fail 路径的挂起定时器不拖累 node:test 收尾
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
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

  // ---- 调用序列(0.3.59,ADR-0012) ----

  /** 启动一条序列:校验入站、拒绝并发、驱动引擎并逐步转发事件。 */
  private startSequence(raw: unknown): void {
    const seq = parseSequence(raw);
    if (!seq) {
      this.send({ type: 'sequenceStoreError', message: vscode.l10n.t('Invalid sequence') });
      return;
    }
    if (this.activeSequence) {
      return; // 已有运行中的序列:忽略(webview 侧按钮亦已禁用)
    }
    const engine = new SequenceRunner({
      runner: this.deps.runner,
      registry: this.deps.registry,
      getConfig: () => {
        const c = this.deps.getConfig();
        return { protoDir: c.protoDir, metadata: c.metadata };
      },
      onEvent: (event) => {
        this.send({ type: 'seqEvent', event });
      },
    });
    this.activeSequence = engine;
    // run 内部全路径捕获,不会 reject;finally 仅作清空兜底(end 事件已先行送达)
    void engine.run(seq).finally(() => {
      if (this.activeSequence === engine) {
        this.activeSequence = null;
      }
    });
  }

  private async listSequences(): Promise<void> {
    if (!this.deps.store) {
      this.send({ type: 'sequences', list: [] });
      return;
    }
    try {
      this.send({ type: 'sequences', list: await this.deps.store.list() });
    } catch (err) {
      this.send({ type: 'sequenceStoreError', message: errText(err) });
    }
  }

  private async saveSequence(raw: unknown): Promise<void> {
    const seq = parseSequence(raw);
    if (!seq || seq.name.trim() === '') {
      this.send({ type: 'sequenceStoreError', message: vscode.l10n.t('A non-empty sequence name is required to save') });
      return;
    }
    if (!this.deps.store) {
      this.send({ type: 'sequenceStoreError', message: vscode.l10n.t('Sequence persistence is unavailable without a workspace folder') });
      return;
    }
    try {
      await this.deps.store.save(seq);
      this.send({ type: 'sequences', list: await this.deps.store.list() });
    } catch (err) {
      this.send({ type: 'sequenceStoreError', message: errText(err) });
    }
  }

  private async loadSequence(name: string): Promise<void> {
    if (!this.deps.store) {
      this.send({ type: 'sequenceLoaded', sequence: null });
      return;
    }
    try {
      this.send({ type: 'sequenceLoaded', sequence: await this.deps.store.get(name) });
    } catch (err) {
      this.send({ type: 'sequenceStoreError', message: errText(err) });
    }
  }

  private async deleteSequence(name: string): Promise<void> {
    if (!this.deps.store) {
      this.send({ type: 'sequences', list: [] });
      return;
    }
    try {
      await this.deps.store.delete(name);
      this.send({ type: 'sequences', list: await this.deps.store.list() });
    } catch (err) {
      this.send({ type: 'sequenceStoreError', message: errText(err) });
    }
  }
}

// ---- vscode 粘合层(以下只在扩展宿主内运行,测试不触达) ----

export type WorkbenchPanelDeps = WorkbenchSessionDeps;

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
      resultTreeScriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'resultTree.js')).toString(),
      placeholderScriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'placeholder.js')).toString(),
      alpineScriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'alpine.min.js')).toString(),
      server: deps.getConfig().server,
      protoDir: deps.getConfig().protoDir,
      metadataDefault: deps.getConfig().metadata,
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
