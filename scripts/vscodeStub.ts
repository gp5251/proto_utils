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
