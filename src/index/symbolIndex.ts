import * as vscode from 'vscode';
import * as path from 'path';
import { parse } from '../parser/parser';
import * as ast from '../parser/ast';
import { collectDefinitions, SymbolEntry } from './symbols';

interface FileEntry {
  uri: vscode.Uri;
  file: ast.ProtoFile;
  symbols: SymbolEntry[];
}

export class SymbolIndex {
  private entries = new Map<string, FileEntry>(); // key: fsPath
  private watcher: vscode.FileSystemWatcher | undefined;

  async build(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.proto', '**/node_modules/**');
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
      const source = Buffer.from(content).toString('utf-8');
      const file = parse(source);
      const symbols = collectDefinitions(file);
      this.entries.set(uri.fsPath, { uri, file, symbols });
    } catch {
      // file may have been deleted between discovery and read
    }
  }

  /** Get parsed file for a uri */
  getFile(uri: vscode.Uri): FileEntry | undefined {
    return this.entries.get(uri.fsPath);
  }

  /** Re-index a document that may have unsaved changes */
  updateFromDocument(document: vscode.TextDocument): void {
    const source = document.getText();
    const file = parse(source);
    const symbols = collectDefinitions(file);
    this.entries.set(document.uri.fsPath, { uri: document.uri, file, symbols });
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
    if (fromEntry?.file.imports) {
      const dir = path.dirname(fromUri.fsPath);
      for (const imp of fromEntry.file.imports) {
        const impPath = path.resolve(dir, imp.path);
        const impEntry = this.entries.get(impPath);
        if (impEntry) {
          const match = this.matchSymbol(impEntry.symbols, typeName);
          if (match) return { uri: impEntry.uri, symbol: match };
        }
      }
    }

    // 3. Global: match by qualified name (package.TypeName)
    for (const [, entry] of this.entries) {
      const pkg = entry.file.package?.name ?? '';
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
