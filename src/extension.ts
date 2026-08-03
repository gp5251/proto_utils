import * as vscode from 'vscode';
import { ProtoDefinitionProvider } from './providers/definition';
import { ProtoSemanticTokensProvider, SEMANTIC_LEGEND } from './providers/semanticTokens';
import { ProtoCallLensProvider, methodAtLine } from './providers/callLens';
import { SymbolIndex } from './index/symbolIndex';
import { ProtoFrontend, ProtoLoadError } from './runtime/protoFrontend';
import { registerCodeGenCommand } from './codegen/command';
import { RunnerViewProvider, RUNNER_VIEW_ID, readRunnerConfig } from './runner/runnerView';
import type { WorkbenchSession } from './runner/workbenchSession';

const PROTO_SELECTOR: vscode.DocumentSelector = { language: 'proto3', scheme: 'file' };

export async function activate(context: vscode.ExtensionContext) {
  const index = new SymbolIndex();
  await index.build();
  context.subscriptions.push({ dispose: () => index.dispose() });

  const includeDirs = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const frontend = new ProtoFrontend(includeDirs);

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(PROTO_SELECTOR, new ProtoDefinitionProvider(index)),
    vscode.languages.registerDocumentSemanticTokensProvider(PROTO_SELECTOR, new ProtoSemanticTokensProvider(index), SEMANTIC_LEGEND),
    vscode.languages.registerCodeLensProvider(PROTO_SELECTOR, new ProtoCallLensProvider(index)),
  );

  registerCodeGenCommand(context, frontend);

  // ---- 调用面:底部面板工作台(会话工厂首次使用时才懒加载 grpc 依赖) ----
  const provider = new RunnerViewProvider(context.extensionUri, async () => {
    const runner = await loadRunnerBundle();
    const registry = new runner.ServiceRegistry();
    const config = readRunnerConfig();
    return new runner.WorkbenchSession({
      registry,
      runner: new runner.GrpcCallRunner(config.server, config.protoDir ?? '', registry),
      getConfig: () => {
        const c = readRunnerConfig();
        return { server: c.server, protoDir: c.protoDir ?? '' };
      },
    });
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RUNNER_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('protoUtils.openRpcRunner', () => {
      void vscode.commands.executeCommand(`${RUNNER_VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('protoUtils.callMethod', (args: { service: string; method: string }) => {
      void provider.showCallTarget(args);
    }),
  );

  // 光标跟随「当前接口」:视图可见时,光标停在 rpc 方法行即切换表单(去抖)
  let followTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push({ dispose: () => clearTimeout(followTimer) });
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.languageId !== 'proto3') return;
      clearTimeout(followTimer);
      followTimer = setTimeout(() => {
        index.updateFromDocument(e.textEditor.document);
        const entry = index.getFile(e.textEditor.document.uri);
        if (!entry) return;
        const target = methodAtLine(entry, e.selections[0].active.line);
        if (target) provider.followCallTarget({ service: target.serviceFullName, method: target.method });
      }, CURSOR_FOLLOW_DEBOUNCE_MS);
    }),
  );

  // proto 变更:语义前端失效 + 工作台热更新(ADR-0004 的 SSE 替代)
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.proto');
  const onProtoChanged = (): void => {
    frontend.invalidate();
    void provider.reload();
  };
  watcher.onDidCreate(onProtoChanged);
  watcher.onDidChange(onProtoChanged);
  watcher.onDidDelete(onProtoChanged);
  context.subscriptions.push(watcher);

  // 保存时诊断(ADR-0002 的既定代价:编辑中态不报,保存才报,首错即止)
  const diagnostics = vscode.languages.createDiagnosticCollection('proto-utils');
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'proto3') return;
      frontend.invalidate();
      try {
        frontend.load();
        diagnostics.clear();
      } catch (err) {
        reportLoadError(diagnostics, err);
      }
    }),
  );
}

function reportLoadError(diagnostics: vscode.DiagnosticCollection, err: unknown): void {
  diagnostics.clear();
  if (!(err instanceof ProtoLoadError) || !err.file) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Proto Utils: ${message}`);
    return;
  }
  const line = Math.max(0, (err.line ?? 1) - 1);
  const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
  const diagnostic = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
  diagnostics.set(vscode.Uri.file(err.file), [diagnostic]);
}

/** 调用面懒加载边界:首次打开工作台时才 import ./runner/index.js,拖入 grpc 依赖(ADR-0008) */
async function loadRunnerBundle(): Promise<typeof import('./runner/index')> {
  // 动态 import 是刻意的:静态 import 会让 grpc-js/protobufjs 进入编辑器激活路径。
  // 必须带 .js:CJS 里的动态 import 走 ESM 解析器,无扩展名解析失败。
  return import('./runner/index.js');
}

/** 光标跟随去抖间隔(ms):光标停下才切「当前接口」,避免划过时表单连跳 */
const CURSOR_FOLLOW_DEBOUNCE_MS = 200;

export function deactivate() {}
