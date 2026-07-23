import * as vscode from 'vscode';
import * as path from 'path';
import { parse } from '../parser/parser';
import { emit, CodeGenConfig, TypeResolver } from './emitter';
import { SymbolIndex } from '../index/symbolIndex';

export function registerCodeGenCommand(
  context: vscode.ExtensionContext,
  index: SymbolIndex,
): void {
  const cmd = vscode.commands.registerCommand('protoUtils.generateTypes', async (uri?: vscode.Uri) => {
    // Resolve target file: explorer context passes uri, editor context uses active editor
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri) {
      vscode.window.showErrorMessage('Proto Utils: No .proto file selected.');
      return;
    }

    const document = await vscode.workspace.openTextDocument(targetUri);
    const source = document.getText();
    const file = parse(source);
    const config = readConfig();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('Proto Utils: No workspace folder open.');
      return;
    }

    // Build type resolver for cross-file imports
    const resolver = buildResolver(targetUri, config, workspaceRoot, index);

    const output = emit(file, config, resolver);
    const outPath = resolveOutputPath(targetUri, file, config, workspaceRoot);

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

function resolveOutputPath(
  protoUri: vscode.Uri,
  file: ReturnType<typeof parse>,
  config: CodeGenConfig,
  workspaceRoot: string,
): string {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  const outputDir = cfg.get<string>('outputDir', 'generated');
  const pathMapping = cfg.get<'package' | 'file'>('pathMapping', 'package');

  let relPath: string;
  if (pathMapping === 'package' && file.package) {
    // package my.service → my/service.ts
    relPath = file.package.name.replace(/\./g, '/') + '.ts';
  } else {
    // Use proto file path relative to workspace, swap extension
    const protoRel = path.relative(workspaceRoot, protoUri.fsPath);
    relPath = protoRel.replace(/\.proto$/, '.ts');
  }

  return path.join(workspaceRoot, outputDir, relPath);
}

function buildResolver(
  fromUri: vscode.Uri,
  _config: CodeGenConfig,
  workspaceRoot: string,
  index: SymbolIndex,
): TypeResolver {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  const outputDir = cfg.get<string>('outputDir', 'generated');
  const pathMapping = cfg.get<'package' | 'file'>('pathMapping', 'package');

  return (typeName: string): string | null => {
    const resolved = index.resolve(typeName, fromUri);
    if (!resolved) return null;
    // Same file → no import needed
    if (resolved.uri.fsPath === fromUri.fsPath) return null;

    // Compute the output TS path of the resolved proto file, relative to current output
    const resolvedEntry = index.getFile(resolved.uri);
    if (!resolvedEntry) return null;

    let targetRel: string;
    if (pathMapping === 'package' && resolvedEntry.file.package) {
      targetRel = resolvedEntry.file.package.name.replace(/\./g, '/') + '.ts';
    } else {
      targetRel = path.relative(workspaceRoot, resolved.uri.fsPath).replace(/\.proto$/, '.ts');
    }

    // Current file's output path
    const fromEntry = index.getFile(fromUri);
    let fromRel: string;
    if (pathMapping === 'package' && fromEntry?.file.package) {
      fromRel = fromEntry.file.package.name.replace(/\./g, '/') + '.ts';
    } else {
      fromRel = path.relative(workspaceRoot, fromUri.fsPath).replace(/\.proto$/, '.ts');
    }

    // Relative path from current output to target output
    const fromDir = path.dirname(fromRel);
    let rel = path.relative(fromDir, targetRel).replace(/\\/g, '/').replace(/\.ts$/, '');
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
  };
}
