import * as vscode from 'vscode';
import path from 'node:path';
import { ProtoDefinitionProvider } from './providers/definition';
import { ProtoSemanticTokensProvider, SEMANTIC_LEGEND } from './providers/semanticTokens';
import { ProtoCallLensProvider } from './providers/callLens';
import { SymbolIndex } from './index/symbolIndex';
import { ProtoFrontend, ProtoLoadError } from './runtime/protoFrontend';
import { resolveRunnerConfig as resolveRunnerConfigPure } from './runner/config';
import { registerCodeGenCommand } from './codegen/command';
import type { WorkbenchPanelManager } from './runner/webviewPanel';

const PROTO_SELECTOR: vscode.DocumentSelector = { language: 'proto3', scheme: 'file' };

export async function activate(context: vscode.ExtensionContext) {
  const index = new SymbolIndex();
  context.subscriptions.push({ dispose: () => index.dispose() });

  const workspaceDirs = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  // 显式配置的 runner.protoDir 作为额外 includeDir:codegen 覆盖 workspace 之外的 proto;
  // 留空时 protoDir 回退 workspace 根,与工作区目录去重后不变(0.3.12)
  const { protoDir } = resolveRunnerConfigPure(
    (key) => vscode.workspace.getConfiguration('protoUtils').get(key),
    workspaceDirs[0],
  );
  const includeDirs = [...workspaceDirs];
  if (protoDir) {
    const target = path.resolve(protoDir).toLowerCase();
    if (!workspaceDirs.some((d) => path.resolve(d).toLowerCase() === target)) includeDirs.push(protoDir);
  }
  const frontend = new ProtoFrontend(includeDirs);

  const callLens = new ProtoCallLensProvider(index);
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(PROTO_SELECTOR, new ProtoDefinitionProvider(index)),
    vscode.languages.registerDocumentSemanticTokensProvider(PROTO_SELECTOR, new ProtoSemanticTokensProvider(index), SEMANTIC_LEGEND),
    vscode.languages.registerCodeLensProvider(PROTO_SELECTOR, callLens),
  );

  // 全量索引后台跑,不阻塞激活:打开文档的 lens/跳转/高亮由各 provider 的
  // updateFromDocument 就地索引(立即可用);全量只服务跨文件解析,完成后刷新 lens。
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Proto Utils: 正在索引 proto 文件…' },
    () => index.build().then(() => callLens.refresh()),
  );

  registerCodeGenCommand(context, frontend);

  // ---- 调用面(懒加载:grpc-js/proto-loader 只在首次打开工作台时载入) ----
  const workbench = new LazyWorkbench(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('protoUtils.openRpcRunner', () => void workbench.reveal()),
    vscode.commands.registerCommand('protoUtils.callMethod', (args: { service: string; method: string }) => {
      void workbench.reveal({ service: args.service, method: args.method });
    }),
  );

  // proto 变更:语义前端失效 + 工作台热更新(ADR-0004 的 SSE 替代)
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.proto');
  const onProtoChanged = (): void => {
    frontend.invalidate();
    void workbench.reload();
  };
  watcher.onDidCreate(onProtoChanged);
  watcher.onDidChange(onProtoChanged);
  watcher.onDidDelete(onProtoChanged);
  context.subscriptions.push(watcher);

  // 保存时诊断(ADR-0002 的既定代价:编辑中态不报,保存才报,首错即止)。
  // 防抖 300ms:快速连续保存只解析一次(load 是同步全量解析,会短暂阻塞宿主)。
  const diagnostics = vscode.languages.createDiagnosticCollection('proto-utils');
  context.subscriptions.push(diagnostics);
  let saveTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'proto3') return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        frontend.invalidate();
        try {
          frontend.load();
          diagnostics.clear();
          lastLoadErrorToast = null;
        } catch (err) {
          reportLoadError(diagnostics, err);
        }
      }, 300);
    }),
  );
}

/** 上一次弹过 toast 的加载错误;相同错误不重复弹(每次保存都失败会刷屏)。 */
let lastLoadErrorToast: string | null = null;

function reportLoadError(diagnostics: vscode.DiagnosticCollection, err: unknown): void {
  diagnostics.clear();
  if (!(err instanceof ProtoLoadError) || !err.file) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === lastLoadErrorToast) return;
    lastLoadErrorToast = message;
    vscode.window.showErrorMessage(`Proto Utils: ${message}`);
    return;
  }
  const line = Math.max(0, (err.line ?? 1) - 1);
  const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
  const diagnostic = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
  diagnostics.set(vscode.Uri.file(err.file), [diagnostic]);
}

/** 工作台单例的懒加载包装:首次使用时才 import ./runner/index,拖入 grpc 依赖 */
class LazyWorkbench {
  private managerPromise: Promise<WorkbenchPanelManager> | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async reveal(prefill?: { service: string; method: string }): Promise<void> {
    const manager = await this.getManager();
    manager.reveal(prefill);
  }

  async reload(): Promise<void> {
    if (this.managerPromise) {
      const manager = await this.managerPromise;
      await manager.reload();
    }
  }

  private async getManager(): Promise<WorkbenchPanelManager> {
    this.managerPromise ??= (async () => {
      // 动态 import 是刻意的:静态 import 会让 grpc-js/protobufjs 进入编辑器激活路径
      // (用户 spec 的懒加载约定);esbuild 对本路径 external,产物 out/runner/index.js 独立加载。
      // 必须带 .js:CJS 里的动态 import 走 ESM 解析器,无扩展名解析失败。
      const runner = await import('./runner/index.js');
      const registry = new runner.ServiceRegistry();
      const config = runner.resolveRunnerConfig();
      const deps = {
        registry,
        runner: new runner.GrpcCallRunner(config.server, config.protoDir, registry),
        getConfig: () => runner.resolveRunnerConfig(),
      };
      return new runner.WorkbenchPanelManager(deps, runner.createVscodePanelFactory(this.context.extensionUri, deps));
    })();
    return this.managerPromise;
  }
}

export function deactivate() {}
