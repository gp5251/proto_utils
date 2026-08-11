import * as vscode from 'vscode';
import path from 'node:path';
import { ProtoFrontend, ProtoLoadError } from '../runtime/protoFrontend';
import {
  emit,
  createOutputPathResolver,
  createTypeResolver,
  hasEmittableTypes,
  schemaHasFile,
  CodeGenConfig,
  OutputPathOptions,
} from './emitter';

export function registerCodeGenCommand(
  context: vscode.ExtensionContext,
  frontend: ProtoFrontend,
): void {
  const cmd = vscode.commands.registerCommand('protoUtils.generateTypes', async (uri?: vscode.Uri) => {
    // Resolve target file: explorer context passes uri, editor context uses active editor
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri) {
      vscode.window.showErrorMessage('Proto Utils: No .proto file selected.');
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('Proto Utils: No workspace folder open.');
      return;
    }

    let schema;
    try {
      schema = frontend.load();
    } catch (err) {
      if (err instanceof ProtoLoadError) {
        const where = err.file ? ` (${err.file}${err.line ? `:${err.line}` : ''})` : '';
        vscode.window.showErrorMessage(`Proto Utils: Failed to parse proto files${where}: ${err.message}`);
        return;
      }
      throw err;
    }

    const filePath = targetUri.fsPath;
    if (!schemaHasFile(schema, filePath)) {
      vscode.window.showErrorMessage('Proto Utils: File is not under the configured proto include dirs.');
      return;
    }

    // 没有任何可生成产物(纯 import 聚合文件):不落空文件,直接说明,避免"Generated 成功但内容为空"的误导。
    if (!hasEmittableTypes(schema, filePath)) {
      vscode.window.showInformationMessage(
        `Proto Utils: ${path.basename(filePath)} declares no message/enum/service types; nothing to generate.`,
      );
      return;
    }

    const config = readConfig();
    const pathOptions = readPathOptions(workspaceRoot);

    // Build type resolver for cross-file imports
    const resolver = createTypeResolver(schema, filePath, pathOptions);

    const output = emit(schema, filePath, config, resolver);
    const outPath = createOutputPathResolver(schema, pathOptions)(filePath);

    // Write file
    const outUri = vscode.Uri.file(outPath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(outPath)));
    await vscode.workspace.fs.writeFile(outUri, Buffer.from(output, 'utf-8'));

    const relative = path.relative(workspaceRoot, outPath);
    vscode.window.showInformationMessage(`Proto Utils: Generated ${relative}`);
  });

  context.subscriptions.push(cmd);
}

function readConfig(): CodeGenConfig {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  return {
    enumStyle: cfg.get<'enum' | 'union'>('enumStyle', 'enum'),
    optionalMessageFields: cfg.get<boolean>('optionalMessageFields', true),
    optionalScalarFields: cfg.get<boolean>('optionalScalarFields', false),
    fieldNaming: cfg.get<'camelCase' | 'preserve'>('fieldNaming', 'camelCase'),
    oneofStyle: cfg.get<'optional' | 'union'>('oneofStyle', 'optional'),
  };
}

function readPathOptions(workspaceRoot: string): OutputPathOptions {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  return {
    workspaceRoot,
    outputDir: cfg.get<string>('outputDir', 'generated'),
    pathMapping: cfg.get<'package' | 'file'>('pathMapping', 'package'),
  };
}
