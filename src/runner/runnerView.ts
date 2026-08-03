import * as vscode from 'vscode';
import { generateNonce, renderWorkbenchHtml } from './webviewHtml';
import { resolveRunnerConfig, RunnerConfig } from './config';
import type { CallTarget, WorkbenchHost, WorkbenchSession } from './workbenchSession';

/**
 * 底部面板工作台(WebviewView 宿主,替代原 tab 面板)。
 * 本模块刻意不 import 任何 grpc 相关运行时:会话由 extension.ts 经懒加载的
 * sessionFactory 注入,编辑器激活路径保持无 grpc 依赖(ADR-0008)。
 */

export const RUNNER_VIEW_ID = 'protoUtils.runnerView';

/** 供注入的异步会话工厂;返回 Promise,避免本模块静态依赖 runner 实现 */
export type SessionFactory = () => Promise<WorkbenchSession>;

/** 读 protoUtils.runner.*(vscode 绑定层,薄壳包纯函数) */
export function readRunnerConfig(): RunnerConfig {
  const config = vscode.workspace.getConfiguration('protoUtils');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return resolveRunnerConfig((key) => config.get(key), root);
}

export class RunnerViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private session: WorkbenchSession | null = null;
  private pendingTarget: CallTarget | null = null;
  private lastPrefill: CallTarget | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionFactory: SessionFactory,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media', 'runner');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };

    const config = readRunnerConfig();
    view.webview.html = renderWorkbenchHtml({
      cspSource: view.webview.cspSource,
      nonce: generateNonce(),
      stylesUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'runner.css')).toString(),
      runnerScriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'runner.js')).toString(),
      alpineScriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'alpine.min.js')).toString(),
      server: config.server,
      protoDir: config.protoDir ?? '',
    });

    const host: WorkbenchHost = {
      postMessage: (message) => {
        void view.webview.postMessage(message);
      },
      onMessage: (listener) => {
        view.webview.onDidReceiveMessage(listener);
      },
      onDispose: (listener) => {
        view.onDidDispose(listener);
      },
    };

    this.view = view;
    view.onDidDispose(() => {
      this.view = null;
      this.session = null;
    });

    // 会话依赖 grpc bundle,异步到达;到达前 webview 先显示 boot 态(loading 卡片)
    void this.sessionFactory().then((session) => {
      if (this.view !== view) {
        // 面板已销毁:会话未 attach,无流无 host,dispose 仅是声明意图的卫生动作
        session.dispose();
        return;
      }
      session.attach(host);
      this.session = session;
      if (this.pendingTarget) {
        const target = this.pendingTarget;
        this.pendingTarget = null;
        session.prefill(target.service, target.method);
      }
    }, (err: unknown) => {
      // grpc bundle 加载失败:不能静默停在 boot 态,给可见错误
      const message = err instanceof Error ? err.message : String(err);
      host.postMessage({ type: 'loadError', errors: [`工作台初始化失败: ${message}`] });
    });
  }

  get isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  /** CodeLens 入口:聚焦底栏视图并预选方法(会话未就绪则挂起,到达后补发) */
  async showCallTarget(target: CallTarget): Promise<void> {
    this.lastPrefill = target;
    if (this.session) {
      this.session.prefill(target.service, target.method);
    } else {
      this.pendingTarget = target;
    }
    await vscode.commands.executeCommand(`${RUNNER_VIEW_ID}.focus`);
  }

  /** 光标跟随入口:仅当视图可见时更新,且同一目标不重复 prefill */
  followCallTarget(target: CallTarget): void {
    if (!this.isVisible || !this.session) return;
    if (this.lastPrefill?.service === target.service && this.lastPrefill?.method === target.method) return;
    this.lastPrefill = target;
    this.session.prefill(target.service, target.method);
  }

  /** proto 变更热更新(无会话时是 no-op) */
  async reload(): Promise<void> {
    await this.session?.reload();
  }
}
