import * as vscode from 'vscode';
import * as path from 'path';
import { scanProto } from './scanner';
import { decodeProto } from '../runtime/protoEncoding';
import { SCAN_EXCLUDED_DIRS } from '../runtime/protoFrontend';
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

  async build(): Promise<void> {
    const excludeGlob = `**/{${SCAN_EXCLUDED_DIRS.join(',')}}/**`;
    const files = await vscode.workspace.findFiles('**/*.proto', excludeGlob);
    await Promise.all(files.map(uri => this.indexFile(uri)));

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.proto');
    this.watcher.onDidCreate(uri => this.indexFile(uri));
    this.watcher.onDidChange(uri => this.indexFile(uri));
    this.watcher.onDidDelete(uri => {
      this.entries.delete(uri.fsPath);
    });
  }

  dispose(): void {
    this.watcher?.dispose();
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
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

    // 3. Global: match by qualified name (package.TypeName)
    for (const [, entry] of this.entries) {
      const pkg = entry.packageName ?? '';
      for (const sym of entry.symbols) {
        const fqn = pkg ? `${pkg}.${sym.qualifiedName}` : sym.qualifiedName;
        if (fqn === typeName || sym.qualifiedName === typeName) {
          return { uri: entry.uri, symbol: sym };
        }
      }
    }

    return null;
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
