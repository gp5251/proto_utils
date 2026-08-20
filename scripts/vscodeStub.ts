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

// 测试环境恒为默认语言:identity 返回英文源串,{0} 占位符由调用方替换
export const l10n = {
  t: (message: string | { message: string }): string =>
    typeof message === 'string' ? message : message.message,
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

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;

export const window = {
  showErrorMessage: () => Promise.resolve(undefined),
  showInformationMessage: () => Promise.resolve(undefined),
};

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
  },
};
