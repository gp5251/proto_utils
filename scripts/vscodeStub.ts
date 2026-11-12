// 仅供 scripts/genGoldens 在 Node 里跑真实 SymbolIndex 的最小 vscode 替身。
import fs from 'node:fs';
import path from 'node:path';

export interface StubUri {
  fsPath: string;
  scheme: string;
  path: string;
}

export const Uri = {
  file: (fsPath: string): StubUri => ({ fsPath, scheme: 'file', path: fsPath }),
};

// 测试环境恒为默认语言:返回英文源串,{0} 占位符按真实 vscode.l10n.t 语义就地替换
export const l10n = {
  t: (message: string | { message: string }, ...args: unknown[]): string => {
    let text = typeof message === 'string' ? message : message.message;
    args.forEach((arg, i) => {
      text = text.replace(new RegExp(`\\{${i}\\}`, 'g'), String(arg));
    });
    return text;
  },
};

export const env = { language: 'en' };

// 诊断测试最小实现:字段形状对齐 vscode(只读语义够用)
export class Range {
  constructor(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;

export class Diagnostic {
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: number = 0,
  ) {}
}

// callLens.refresh() 依赖的最小事件器:onDidChangeCodeLenses 由 changeEmitter.event 提供
export class EventEmitter<T = void> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event: (listener: (value: T) => void) => { dispose(): void } = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}

export class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: unknown,
  ) {}
}

// hover/documentSymbol 测试最小实现:字段形状对齐 vscode(只读语义够用)
export class MarkdownString {
  value = '';
  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
  appendCodeblock(code: string, language = ''): this {
    this.value += '```' + language + '\n' + code + '\n```';
    return this;
  }
  appendText(text: string): this {
    this.value += text;
    return this;
  }
}

export class Hover {
  constructor(
    readonly contents: MarkdownString | MarkdownString[],
    readonly range?: Range,
  ) {}
}

export class Location {
  constructor(
    readonly uri: StubUri,
    readonly range: Range,
  ) {}
}

export const SymbolKind = {
  Method: 5,
  Enum: 9,
  Interface: 10,
  Struct: 22,
} as const;

export class DocumentSymbol {
  readonly children: DocumentSymbol[] = [];
  constructor(
    public name: string,
    public detail: string,
    public kind: number,
    public range: Range,
    public selectionRange: Range,
  ) {}
}

// semanticTokens 测试最小实现:形状对齐 vscode(builder 记录 push 序列,build 出 data)
export class SemanticTokensLegend {
  constructor(
    public readonly tokenTypes: readonly string[],
    public readonly tokenModifiers: readonly string[] = [],
  ) {}
}

export class SemanticTokensBuilder {
  private readonly data: number[] = [];
  constructor(_legend?: unknown) {}
  push(line: number, char: number, length: number, tokenType: number, tokenModifier = 0): void {
    this.data.push(line, char, length, tokenType, tokenModifier);
  }
  build(): { data: Uint32Array } {
    return { data: new Uint32Array(this.data) };
  }
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;

// missingImportCodeAction 测试最小实现:字段形状对齐 vscode(只读语义够用)
export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export const CodeActionKind = { QuickFix: 'quickfix' } as const;

export class CodeAction {
  diagnostics?: Diagnostic[];
  edit?: WorkspaceEdit;
  isPreferred?: boolean;
  constructor(
    readonly title: string,
    readonly kind?: string,
  ) {}
}

export class WorkspaceEdit {
  readonly inserts: { uri: StubUri; position: Position; text: string }[] = [];
  insert(uri: StubUri, position: Position, text: string): void {
    this.inserts.push({ uri, position, text });
  }
}

// ── 0.3.89:命令层测试面(registerCodeGenCommand)——消息记录/命令注册/配置注入 ──
export interface StubMessage {
  kind: 'error' | 'info' | 'warning';
  message: string;
  items: string[];
}
export const stubMessages: StubMessage[] = [];
export const stubOpened: StubUri[] = [];
let nextMessageChoice: string | undefined;
/** 注入「用户点了通知里的某个按钮」(一次性,消费后复位)。 */
export function setNextMessageChoice(choice: string | undefined): void {
  nextMessageChoice = choice;
}

function recordMessage(kind: StubMessage['kind'], message: string, items: string[]): Promise<string | undefined> {
  stubMessages.push({ kind, message, items });
  const choice = nextMessageChoice;
  nextMessageChoice = undefined;
  return Promise.resolve(choice);
}

let activeEditor: { document: { uri: StubUri } } | undefined;
export function setActiveTextEditor(uri: StubUri | undefined): void {
  activeEditor = uri ? { document: { uri } } : undefined;
}

// withProgress 替身:report 计数,token 在 report 次数达到阈值后视为已取消
let progressReports = 0;
let cancelAfterReports = Number.POSITIVE_INFINITY;
export function setCancelAfterReports(n: number): void {
  cancelAfterReports = n;
}
export const ProgressLocation = { Notification: 15 } as const;

export const window = {
  showErrorMessage: (message: string, ...items: string[]) => recordMessage('error', message, items),
  showInformationMessage: (message: string, ...items: string[]) => recordMessage('info', message, items),
  // 0.3.72:宿主侧确认对话框(序列删除/同名覆盖)。VS Code webview 是沙箱 iframe,
  // 未设 allow-modals,webview 里的 confirm() 被忽略并抛错——确认一律走宿主原生对话框。
  // 测试经 PROTO_UTILS_STUB_CONFIRM=1 注入「点了第一项(确认)」,缺省 = 取消。
  showWarningMessage: (message: string, _options?: unknown, ...items: string[]) => {
    const confirmed = process.env.PROTO_UTILS_STUB_CONFIRM === '1';
    stubMessages.push({ kind: 'warning', message, items });
    return Promise.resolve(confirmed ? items[0] : undefined);
  },
  showTextDocument: async (uri: StubUri) => {
    stubOpened.push(uri);
    return {};
  },
  withProgress: async <T>(
    _options: unknown,
    task: (
      progress: { report(value: { message?: string; increment?: number }): void },
      token: { isCancellationRequested: boolean; onCancellationRequested: unknown },
    ) => Promise<T>,
  ): Promise<T> => {
    progressReports = 0;
    return task(
      { report: () => { progressReports++; } },
      {
        get isCancellationRequested() { return progressReports >= cancelAfterReports; },
        onCancellationRequested: () => ({ dispose() {} }),
      },
    );
  },
  get activeTextEditor() { return activeEditor; },
};

export const commands = {
  handlers: new Map<string, (...args: never[]) => unknown>(),
  registerCommand(name: string, fn: (...args: never[]) => unknown): { dispose(): void } {
    this.handlers.set(name, fn);
    return { dispose: () => this.handlers.delete(name) };
  },
  executeCommand(name: string, ...args: unknown[]): unknown {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`command not registered: ${name}`);
    return (fn as (...a: unknown[]) => unknown)(...args);
  },
};

let folders: { uri: StubUri; name: string; index: number }[] = [];
export function setWorkspaceFolders(dirs: string[]): void {
  folders = dirs.map((d, i) => ({ uri: Uri.file(d), name: path.basename(d), index: i }));
}

let configOverrides: Record<string, unknown> = {};
export function setConfigOverrides(values: Record<string, unknown>): void {
  configOverrides = values;
}

let failWriteFor = '';
/** 注入「某个输出路径写盘失败」,验证逐文件错误汇总。 */
export function setWriteFailure(fsPath: string): void {
  failWriteFor = fsPath;
}

/** 每个用例前复位全部注入态,避免跨用例串扰。 */
export function resetCodeGenStub(): void {
  stubMessages.length = 0;
  stubOpened.length = 0;
  nextMessageChoice = undefined;
  activeEditor = undefined;
  cancelAfterReports = Number.POSITIVE_INFINITY;
  folders = [];
  configOverrides = {};
  failWriteFor = '';
}

let corpusRoot = '';
export function setCorpusRoot(dir: string): void {
  corpusRoot = dir;
}

// 测试可用环境变量按用例切换根目录,无需 import stub 本体
function activeRoot(): string {
  return corpusRoot || process.env.PROTO_UTILS_STUB_ROOT || '';
}

function walk(dir: string, out: string[], excluded?: Set<string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !(excluded && excluded.has(entry.name))) walk(full, out, excluded);
    } else if (entry.name.endsWith('.proto')) {
      out.push(full);
    }
  }
}

export const workspace = {
  get workspaceFolders() { return folders.length > 0 ? folders : undefined; },
  getConfiguration: (section: string) => ({
    get: <T>(key: string, dflt?: T): T | undefined => {
      const full = `${section}.${key}`;
      return Object.hasOwn(configOverrides, full) ? (configOverrides[full] as T) : dflt;
    },
  }),
  findFiles: async (_pattern: string, excludePattern?: string) => {
    // 对齐真实 vscode.workspace.findFiles:从 '**/{a,b,c}/**' 提取排除目录名
    const excluded = new Set<string>();
    const m = /^\*\*\/\{(.+)\}\/\*\*$/.exec(excludePattern ?? '');
    if (m) {
      for (const name of m[1].split(',')) excluded.add(name);
    }
    const files: string[] = [];
    walk(activeRoot(), files, excluded);
    return files.map((f) => Uri.file(f));
  },
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({}),
    onDidChange: () => ({}),
    onDidDelete: () => ({}),
    dispose: () => {},
  }),
  fs: {
    readFile: async (uri: StubUri) => fs.readFileSync(uri.fsPath),
    writeFile: async (uri: StubUri, content: Uint8Array) => {
      if (failWriteFor && path.normalize(uri.fsPath) === path.normalize(failWriteFor)) {
        throw new Error('stub: write denied');
      }
      fs.writeFileSync(uri.fsPath, content);
    },
    createDirectory: async (uri: StubUri) => {
      fs.mkdirSync(uri.fsPath, { recursive: true });
    },
  },
};
