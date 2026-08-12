import * as vscode from 'vscode';
import path from 'node:path';
import { ProtoFrontend, ProtoLoadError, ProtoSchema } from '../runtime/protoFrontend';
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
  /** 加载 schema;解析失败时报告并返回 null(两个命令共用)。 */
  const loadSchema = (): ProtoSchema | null => {
    try {
      return frontend.load();
    } catch (err) {
      if (err instanceof ProtoLoadError) {
        const where = err.file ? ` (${err.file}${err.line ? `:${err.line}` : ''})` : '';
        vscode.window.showErrorMessage(
          vscode.l10n.t('Proto Utils: Failed to parse proto files{0}: {1}', where, err.message),
        );
        return null;
      }
      throw err;
    }
  };

  /** 单文件生成 + 落盘,返回相对 workspace 的输出路径;无产物返回 null。 */
  const writeTypesFor = async (
    schema: ProtoSchema,
    filePath: string,
    config: CodeGenConfig,
    pathOptions: OutputPathOptions,
  ): Promise<string | null> => {
    if (!hasEmittableTypes(schema, filePath)) return null;
    const output = emit(schema, filePath, config, createTypeResolver(schema, filePath, pathOptions));
    const outPath = createOutputPathResolver(schema, pathOptions)(filePath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(outPath)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(outPath), Buffer.from(output, 'utf-8'));
    return path.relative(pathOptions.workspaceRoot, outPath);
  };

  const cmd = vscode.commands.registerCommand('protoUtils.generateTypes', async (uri?: vscode.Uri) => {
    // Resolve target file: explorer context passes uri, editor context uses active editor
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri) {
      vscode.window.showErrorMessage(vscode.l10n.t('Proto Utils: No .proto file selected.'));
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage(vscode.l10n.t('Proto Utils: No workspace folder open.'));
      return;
    }

    const schema = loadSchema();
    if (!schema) return;

    const filePath = targetUri.fsPath;
    if (!schemaHasFile(schema, filePath)) {
      vscode.window.showErrorMessage(vscode.l10n.t('Proto Utils: File is not under the configured proto include dirs.'));
      return;
    }

    // 没有任何可生成产物(纯 import 聚合文件):不落空文件,直接说明,避免"Generated 成功但内容为空"的误导。
    if (!hasEmittableTypes(schema, filePath)) {
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Proto Utils: {0} declares no message/enum/service types; nothing to generate.',
          path.basename(filePath),
        ),
      );
      return;
    }

    const relative = await writeTypesFor(schema, filePath, readConfig(), readPathOptions(workspaceRoot));
    // 上游已拦截无产物情形,此处仅类型收窄
    if (relative) {
      vscode.window.showInformationMessage(vscode.l10n.t('Proto Utils: Generated {0}', relative));
    }
  });

  const allCmd = vscode.commands.registerCommand('protoUtils.generateAllTypes', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage(vscode.l10n.t('Proto Utils: No workspace folder open.'));
      return;
    }

    const schema = loadSchema();
    if (!schema) return;

    const config = readConfig();
    const pathOptions = readPathOptions(workspaceRoot);

    // file 平铺模式下同名 proto(package 模式下同包文件)会映射到同一输出文件互相覆盖:先检测再动笔
    const outPathOf = createOutputPathResolver(schema, pathOptions);
    const ownerByOut = new Map<string, string>();
    for (const filePath of schema.files) {
      if (!hasEmittableTypes(schema, filePath)) continue;
      const outPath = outPathOf(filePath);
      const owner = ownerByOut.get(outPath);
      if (owner) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'Proto Utils: Output path conflict — {0} and {1} both map to {2}.',
            path.basename(owner),
            path.basename(filePath),
            path.relative(workspaceRoot, outPath),
          ),
        );
        return;
      }
      ownerByOut.set(outPath, filePath);
    }

    let written = 0;
    for (const filePath of schema.files) {
      if (await writeTypesFor(schema, filePath, config, pathOptions)) written++;
    }
    vscode.window.showInformationMessage(
      vscode.l10n.t('Proto Utils: Generated {0} files under {1}/', written, pathOptions.outputDir),
    );
  });

  context.subscriptions.push(cmd, allCmd);
}

function readConfig(): CodeGenConfig {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  return {
    enumStyle: cfg.get<'enum' | 'union'>('enumStyle', 'enum'),
    optionalMessageFields: cfg.get<boolean>('optionalMessageFields', true),
    optionalScalarFields: cfg.get<boolean>('optionalScalarFields', false),
    fieldNaming: cfg.get<'camelCase' | 'preserve'>('fieldNaming', 'camelCase'),
    oneofStyle: cfg.get<'optional' | 'union'>('oneofStyle', 'optional'),
    importExtension: cfg.get<'ts' | 'none'>('importExtension', 'ts'),
  };
}

function readPathOptions(workspaceRoot: string): OutputPathOptions {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  return {
    workspaceRoot,
    outputDir: cfg.get<string>('outputDir', 'generated'),
    pathMapping: cfg.get<'package' | 'file'>('pathMapping', 'file'),
  };
}
