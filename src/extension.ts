import * as vscode from 'vscode';
import { ProtoDefinitionProvider } from './providers/definition';
import { ProtoSemanticTokensProvider, SEMANTIC_LEGEND } from './providers/semanticTokens';
import { SymbolIndex } from './index/symbolIndex';
import { ProtoFrontend } from './runtime/protoFrontend';
import { registerCodeGenCommand } from './codegen/command';

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
  );

  registerCodeGenCommand(context, frontend);
}

export function deactivate() {}
