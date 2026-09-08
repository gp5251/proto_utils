import * as vscode from 'vscode';
import * as path from 'path';
import { scanProto } from './scanner';
import { decodeProto } from '../runtime/protoEncoding';
import { SCAN_EXCLUDED_DIRS } from '../runtime/protoFrontend';
import { EMPTY_SCAN_EXCLUDES, isDirExcluded, ScanExcludes } from '../runner/config';
import { SymbolEntry, ServicePoint, TypeRef } from './symbols';

/**
 * 位置索引层(ADR-0003)的单文件条目:只有定义点符号与声明性事实
 * (package / import 路径),不含 AST,不做任何语义解析。
 */
export interface FileEntry {
  uri: vscode.Uri;
  packageName: string | null;
  imports: string[];
  symbols: SymbolEntry[];
  services: ServicePoint[];
  typeRefs: TypeRef[];
}

export class SymbolIndex {
  private entries = new Map<string, FileEntry>(); // key: fsPath
  private watcher: vscode.FileSystemWatcher | undefined;
  /**
   * tier-3 全局档的 fqn/qualifiedName → 定义点索引(0.3.48 性能):此前 resolve
   * 全局档每次 O(entries×symbols) 线性扫,而 semanticTokens 对每个唯一类型名
   * resolve 一次,大仓下高亮重算退化为 O(refs×symbols)。惰性建一次 Map 后查询
   * O(1);entries 任何增删改即失效,下次 resolve 重建(与就地索引同源)。
   */
  private globalIndex: Map<string, { uri: vscode.Uri; symbol: SymbolEntry }> | null = null;

  /**
   * excludes:用户配置的 scan.excludeDirs(0.3.44 起生效)。此前只排除内建
   * 构建产物目录,与调用面/语义前端的扫描口径不一致;现在三层同源。
   */
  constructor(private readonly excludes: ScanExcludes = EMPTY_SCAN_EXCLUDES) {}

  async build(): Promise<void> {
    const excludeGlob = `**/{${SCAN_EXCLUDED_DIRS.join(',')}}/**`;
    const files = await vscode.workspace.findFiles('**/*.proto', excludeGlob);
    // 分批索引 + 批间让出事件循环(0.3.49 性能):此前 Promise.all 并发全部
    // indexFile,上千 proto 的 scanProto 同步块密集排满主线程,饿死
    // provideCodeLenses/hover(调用按钮延迟很久才出现,autoshop 大仓现场)。
    // 批间 setImmediate 让出后编辑器请求可插队;watcher 增量仍走 indexFile 单文件。
    const BATCH = 16;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(files.slice(i, i + BATCH).map(uri => this.indexFile(uri)));
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.proto');
    this.watcher.onDidCreate(uri => this.indexFile(uri));
    this.watcher.onDidChange(uri => this.indexFile(uri));
    this.watcher.onDidDelete(uri => {
      this.entries.delete(uri.fsPath);
      this.globalIndex = null;
    });
  }

  dispose(): void {
    this.watcher?.dispose();
  }

  /** 文件是否落在用户排除目录内:任一祖先目录命中即排除(与逐层扫描同语义)。 */
  private isExcluded(fsPath: string): boolean {
    let dir = path.dirname(fsPath);
    for (;;) {
      if (isDirExcluded(path.basename(dir), dir, this.excludes)) return true;
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    if (this.isExcluded(uri.fsPath)) return;
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      const scanned = scanProto(decodeProto(content));
      this.entries.set(uri.fsPath, {
        uri,
        packageName: scanned.packageName,
        imports: scanned.imports,
        symbols: scanned.symbols,
        services: scanned.services,
        typeRefs: scanned.typeRefs,
      });
      this.globalIndex = null;
    } catch {
      // file may have been deleted between discovery and read
    }
  }

  /** Get scanned entry for a uri */
  getFile(uri: vscode.Uri): FileEntry | undefined {
    return this.entries.get(uri.fsPath);
  }

  /** Re-index a document that may have unsaved changes */
  updateFromDocument(document: vscode.TextDocument): void {
    const scanned = scanProto(document.getText());
    this.entries.set(document.uri.fsPath, {
      uri: document.uri,
      packageName: scanned.packageName,
      imports: scanned.imports,
      symbols: scanned.symbols,
      services: scanned.services,
      typeRefs: scanned.typeRefs,
    });
    this.globalIndex = null;
  }

  /**
   * Resolve a type reference from a given file.
   * Resolution order: same file → imported files → global (package match).
   */
  resolve(typeName: string, fromUri: vscode.Uri): { uri: vscode.Uri; symbol: SymbolEntry } | null {
    // Normalize: strip leading dot from fully-qualified names (.pkg.Type → pkg.Type)
    typeName = typeName.replace(/^\./, '');
    const fromEntry = this.entries.get(fromUri.fsPath);

    // 1. Same file
    if (fromEntry) {
      const local = this.matchSymbol(fromEntry.symbols, typeName);
      if (local) return { uri: fromUri, symbol: local };
    }

    // 2. Imported files (direct imports)
    if (fromEntry) {
      const dir = path.dirname(fromUri.fsPath);
      for (const imp of fromEntry.imports) {
        const impPath = path.resolve(dir, imp);
        const impEntry = this.entries.get(impPath);
        if (impEntry) {
          const match = this.matchSymbol(impEntry.symbols, typeName);
          if (match) return { uri: impEntry.uri, symbol: match };
        }
      }
    }

    // 3. Global: match by qualified name (package.TypeName) — 惰性 Map,O(1) 查(0.3.48)
    return this.ensureGlobalIndex().get(typeName) ?? null;
  }

  /**
   * 全局档索引:fqn(package.qualifiedName)与裸 qualifiedName 都作 key 指向定义点。
   * 遍历序 = entries 插入序 × symbols 数组序,每 key 首个插入者胜出——精确复刻
   * 原线性扫描「返回第一个 fqn 或 qualifiedName 匹配的 symbol」语义。
   */
  private ensureGlobalIndex(): Map<string, { uri: vscode.Uri; symbol: SymbolEntry }> {
    if (this.globalIndex) return this.globalIndex;
    const idx = new Map<string, { uri: vscode.Uri; symbol: SymbolEntry }>();
    for (const [, entry] of this.entries) {
      const pkg = entry.packageName ?? '';
      for (const sym of entry.symbols) {
        const point = { uri: entry.uri, symbol: sym };
        const fqn = pkg ? `${pkg}.${sym.qualifiedName}` : sym.qualifiedName;
        if (!idx.has(fqn)) idx.set(fqn, point);
        if (!idx.has(sym.qualifiedName)) idx.set(sym.qualifiedName, point);
      }
    }
    this.globalIndex = idx;
    return idx;
  }

  private matchSymbol(symbols: SymbolEntry[], typeName: string): SymbolEntry | null {
    // Try exact qualified name match first, then simple name
    const baseName = typeName.includes('.') ? typeName.split('.').pop()! : typeName;
    return (
      symbols.find(s => s.qualifiedName === typeName) ??
      symbols.find(s => s.name === baseName) ??
      null
    );
  }
}
