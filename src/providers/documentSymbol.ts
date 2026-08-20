import * as vscode from 'vscode';
import { SymbolIndex } from '../index/symbolIndex';
import { SymbolEntry } from '../index/symbols';
import { toVsCodeRange } from './definition';

/**
 * 大纲/符号导航:零语义索引(ADR-0003)的定义点直接够用。
 * message → Struct,enum → Enum,service → Interface;service 的 rpc 方法
 * 作为对应 service 符号的 children(Method)。嵌套类型平铺,不建嵌套树;
 * 返回顺序即 scanner 的文档顺序。
 */

const SYMBOL_KIND: Record<SymbolEntry['kind'], vscode.SymbolKind> = {
  message: vscode.SymbolKind.Struct,
  enum: vscode.SymbolKind.Enum,
  service: vscode.SymbolKind.Interface,
};

export class ProtoDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly index: SymbolIndex) {}

  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    this.index.updateFromDocument(document);
    const entry = this.index.getFile(document.uri);
    if (!entry) return [];

    const serviceSymbols = new Map<string, vscode.DocumentSymbol>();
    const result: vscode.DocumentSymbol[] = [];
    for (const sym of entry.symbols) {
      const range = toVsCodeRange(sym.range);
      const docSymbol = new vscode.DocumentSymbol(sym.name, sym.qualifiedName, SYMBOL_KIND[sym.kind], range, range);
      result.push(docSymbol);
      if (sym.kind === 'service') serviceSymbols.set(sym.name, docSymbol);
    }
    // rpc 方法挂到同名 service 符号下(entry.symbols 中 service 与 entry.services 同源)
    for (const service of entry.services) {
      const parent = serviceSymbols.get(service.name);
      if (!parent) continue;
      for (const method of service.methods) {
        const range = toVsCodeRange(method.range);
        parent.children.push(new vscode.DocumentSymbol(method.name, '', vscode.SymbolKind.Method, range, range));
      }
    }
    return result;
  }
}
