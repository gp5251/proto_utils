import * as vscode from 'vscode';
import { ProtoDefinitionProvider } from './providers/definition';
import { ProtoSemanticTokensProvider, SEMANTIC_LEGEND } from './providers/semanticTokens';
import { ProtoCallLensProvider } from './providers/callLens';
import { ProtoHoverProvider } from './providers/hover';
import { ProtoDocumentSymbolProvider } from './providers/documentSymbol';
import { MissingImportCodeActionProvider } from './providers/missingImportCodeAction';
import { SymbolIndex } from './index/symbolIndex';
import { ProtoFrontend } from './runtime/protoFrontend';
import { createLoadDiagnosticsTrigger } from './loadDiagnostics';
import { RetryableLazy } from './retryableLazy';
import { resolveRunnerConfig as resolveRunnerConfigPure, resolveScanExcludes, ScanExcludes } from './runner/config';
import { registerCodeGenCommand } from './codegen/command';
import type { WorkbenchPanelManager } from './runner/webviewPanel';

const PROTO_SELECTOR: vscode.DocumentSelector = { language: 'proto3', scheme: 'file' };

export async function activate(context: vscode.ExtensionContext) {
  const workspaceDirs = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const getSetting = (key: string): unknown => vscode.workspace.getConfiguration('protoUtils').get(key);
  const { protoDir, protoDirExplicit } = resolveRunnerConfigPure(getSetting, workspaceDirs[0]);
  // 用户配置的扫描排除目录,runner/codegen/位置索引三层共用(0.3.13;索引层 0.3.44 起接入)
  const scanExcludes = resolveScanExcludes(getSetting, workspaceDirs[0]);

  const index = new SymbolIndex(scanExcludes);
  context.subscriptions.push({ dispose: () => index.dispose() });

  // codegen 扫描根:显式配置 runner.protoDir → 只扫 protoDir;留空 → 扫 workspace(0.3.14)
  const includeDirs = protoDirExplicit && protoDir ? [protoDir] : workspaceDirs;
  const frontend = new ProtoFrontend(includeDirs, scanExcludes);

  const callLens = new ProtoCallLensProvider(index);
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(PROTO_SELECTOR, new ProtoDefinitionProvider(index)),
    vscode.languages.registerDocumentSemanticTokensProvider(PROTO_SELECTOR, new ProtoSemanticTokensProvider(index), SEMANTIC_LEGEND),
    vscode.languages.registerCodeLensProvider(PROTO_SELECTOR, callLens),
    vscode.languages.registerHoverProvider(PROTO_SELECTOR, new ProtoHoverProvider(index)),
    vscode.languages.registerDocumentSymbolProvider(PROTO_SELECTOR, new ProtoDocumentSymbolProvider(index)),
    vscode.languages.registerCodeActionsProvider(PROTO_SELECTOR, new MissingImportCodeActionProvider(), {
      providedCodeActionKinds: MissingImportCodeActionProvider.providedCodeActionKinds,
    }),
  );

  // 全量索引后台跑,不阻塞激活:打开文档的 lens/跳转/高亮由各 provider 的
  // updateFromDocument 就地索引(立即可用);全量只服务跨文件解析,完成后刷新 lens。
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Proto Utils: Indexing proto files…') },
    () => index.build().then(() => callLens.refresh()),
  );

  registerCodeGenCommand(context, frontend);

  // 诊断集合与防抖触发器先于工作台创建:onLoadSettled 回调闭包引用二者(0.3.40)。
  // 触发时机(ADR-0002 既定代价:编辑中态不报):保存 proto 时 + 工作台加载尘埃落定时。
  const diagnostics = vscode.languages.createDiagnosticCollection('proto-utils');
  context.subscriptions.push(diagnostics);
  const loadDiagnosticsTrigger = createLoadDiagnosticsTrigger(diagnostics, frontend);
  context.subscriptions.push(loadDiagnosticsTrigger);

  // ---- 调用面(懒加载:grpc-js/proto-loader 只在首次打开工作台时载入) ----
  const workbench = new LazyWorkbench(context, scanExcludes, loadDiagnosticsTrigger.trigger);
  context.subscriptions.push(
    vscode.commands.registerCommand('protoUtils.openRpcRunner', () => void workbench.reveal()),
    vscode.commands.registerCommand('protoUtils.callMethod', (args: { service: string; method: string }) => {
      void workbench.reveal({ service: args.service, method: args.method });
    }),
  );

  // proto 变更 → 工作台热更新(ADR-0004 的 SSE 替代)。
  // 防抖 + 批量合并(0.3.48 性能):git 切分支/codegen 批量写入会让 **/*.proto
  // watcher 成百上千次触发;此前每次都 frontend.invalidate()(盲清摧毁 0.3.45
  // 的 mtime 指纹门)+ workbench.reload()(全量同步重解析),扩展宿主主线程被连续
  // 同步块占死数分钟,CodeLens/hover 请求饿死。现在 500ms 内多次触发只重载一次;
  // 且不再盲 invalidate——frontend.load / protoCache 各自的 mtime 指纹门按 stat
  // 判定变更,未变的文件直接复用,只有真正改动的才重解析。
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.proto');
  let reloadTimer: NodeJS.Timeout | undefined;
  const onProtoChanged = (): void => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void workbench.reload(), 500);
  };
  watcher.onDidCreate(onProtoChanged);
  watcher.onDidChange(onProtoChanged);
  watcher.onDidDelete(onProtoChanged);
  context.subscriptions.push(watcher, { dispose: () => clearTimeout(reloadTimer) });

  // 保存时诊断走共享触发器(防抖在触发器内,0.3.40)。
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'proto3') return;
      loadDiagnosticsTrigger.trigger();
    }),
  );
}

/** 工作台单例的懒加载包装:首次使用时才 import ./runner/index,拖入 grpc 依赖 */
class LazyWorkbench {
  // 失败即弃的懒单例(0.3.44):动态 import/依赖构建失败不再永久缓存 rejected
  // promise 毒化后续打开——下次 reveal 自动重试。
  private readonly manager = new RetryableLazy<WorkbenchPanelManager>(() => this.buildManager());

  /**
   * runner 侧缓存的失效钩子(buildManager 装配时注册):watcher 触发 reload 时,
   * 面板尚未打开/已销毁也必须失效——否则关闭期间改动 proto,重开面板或下一次
   * RPC 会命中 ServiceRegistry/protoCache/服务文件缓存 的陈旧数据(0.3.44 补)。
   */
  private invalidateRunnerCaches: (() => void) | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly scanExcludes: ScanExcludes,
    /** 工作台 proto 加载尘埃落定(成功/部分错误/抛错)时回调:诊断平面借此补一次飘红(0.3.40) */
    private readonly onLoadSettled: () => void,
  ) {}

  async reveal(prefill?: { service: string; method: string }): Promise<void> {
    try {
      // 冷启动 reveal 触发懒加载(bundle import 拖入 grpc-js/protobufjs),可能数秒无反馈;
      // 弹通知进度提示。仅未启动时弹:已启动(含上次失败后的重试)直接复用同一 promise。
      const manager = this.manager.started
        ? await this.manager.get()
        : await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t('Proto Utils: Loading RPC Workbench…'),
              cancellable: false,
            },
            () => this.manager.get(),
          );
      manager.reveal(prefill);
    } catch (err) {
      // 构建失败必须可见(此前静默吞掉,表现为"点了没反应");重置已由 RetryableLazy 完成
      vscode.window.showErrorMessage(
        vscode.l10n.t('Proto Utils: Failed to open RPC Workbench: {0}', err instanceof Error ? err.message : String(err)),
      );
    }
  }

  async reload(): Promise<void> {
    // 先无条件失效缓存(钩子在首次构建后可用):此前的早退会让面板关闭期间的
    // proto 改动绕过 invalidate,重开即见过期服务列表
    this.invalidateRunnerCaches?.();
    if (!this.manager.started) return;
    try {
      const manager = await this.manager.get();
      await manager.reload();
    } catch {
      // 构建失败不打断 watcher 链路;下次 reveal 时会报错并可重试
    }
  }

  private async buildManager(): Promise<WorkbenchPanelManager> {
    // 动态 import 是刻意的:静态 import 会让 grpc-js/protobufjs 进入编辑器激活路径
    // (用户 spec 的懒加载约定);esbuild 对本路径 external,产物 out/runner/index.js 独立加载。
    // 必须带 .js:CJS 里的动态 import 走 ESM 解析器,无扩展名解析失败。
    const runner = await import('./runner/index.js');
    const registry = new runner.ServiceRegistry(this.scanExcludes);
    // 命名序列持久化(0.3.59,ADR-0012):存工作区文件 .proto-utils/sequences.json;
    // 无工作区则不注入 store,序列存/载/删降级为不可用(运行仍可用)。
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const deps = {
      registry,
      // 配置经 getConfig 每次调用现读(0.3.44):server/protoDir/TLS/超时改动即时生效,
      // 服务列表与实际调用两条路径读同一份配置,不再出现「列表新目录、调用旧目录」的劈叉。
      runner: new runner.GrpcCallRunner(() => runner.resolveRunnerConfig(), registry),
      getConfig: () => runner.resolveRunnerConfig(),
      onLoadSettled: this.onLoadSettled,
      // 顶栏连接状态点(0.3.54):与调用路径读同一份现读配置(server+TLS),配置改动即时生效;
      // TLS 配置错会在此抛错,session 按不可达处理(状态点转红),精确错误仍由实际调用面报出。
      probeConnection: () => {
        const cfg = runner.resolveRunnerConfig();
        return runner.probeServerConnectivity(cfg.server, runner.buildChannelCredentials(cfg.tls));
      },
      ...(wsRoot ? { store: new runner.SequenceStore(wsRoot) } : {}),
    };
    this.invalidateRunnerCaches = () => registry.invalidate();
    return new runner.WorkbenchPanelManager(deps, runner.createVscodePanelFactory(this.context.extensionUri, deps));
  }
}

export function deactivate() {}
