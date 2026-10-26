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
  /** 项目级配置 get(0.3.82):命中 codeGen.* 键压过 VS Code settings */
  projectGet: (key: string) => unknown,
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

  /** 单文件生成 + 落盘,返回输出路径与是否真发生写入;无产物返回 null。 */
  const writeTypesFor = async (
    schema: ProtoSchema,
    filePath: string,
    config: CodeGenConfig,
    pathOptions: OutputPathOptions,
  ): Promise<{ outPath: string; relative: string; changed: boolean } | null> => {
    if (!hasEmittableTypes(schema, filePath)) return null;
    const output = emit(schema, filePath, config, createTypeResolver(schema, filePath, pathOptions));
    const outPath = createOutputPathResolver(schema, pathOptions)(filePath);
    const bytes = Buffer.from(output, 'utf-8');
    // 内容未变则不落盘(0.3.70):免无谓写,批量报告也能区分「写入 / 未变」
    let changed = true;
    try {
      const existing = await vscode.workspace.fs.readFile(vscode.Uri.file(outPath));
      changed = Buffer.compare(existing, bytes) !== 0;
    } catch {
      changed = true; // 不存在或读不到 = 需要写
    }
    if (changed) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(outPath)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(outPath), bytes);
    }
    return { outPath, relative: path.relative(pathOptions.workspaceRoot, outPath), changed };
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

    const outcome = await writeTypesFor(schema, filePath, readConfig(projectGet), readPathOptions(workspaceRoot, projectGet));
    // 上游已拦截无产物情形,此处仅类型收窄
    if (outcome) {
      if (outcome.changed) {
        // 0.3.70:成功通知带「打开」动作,省去自己去目录里翻
        const openLabel = vscode.l10n.t('Open');
        vscode.window
          .showInformationMessage(vscode.l10n.t('Proto Utils: Generated {0}', outcome.relative), openLabel)
          .then(
            (choice) => {
              if (choice === openLabel) {
                void vscode.window.showTextDocument(vscode.Uri.file(outcome.outPath));
              }
            },
            () => {
              /* 通知被关闭:无需处理 */
            },
          );
      } else {
        vscode.window.showInformationMessage(
          vscode.l10n.t('Proto Utils: {0} is already up to date', outcome.relative),
        );
      }
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

    const config = readConfig(projectGet);
    const pathOptions = readPathOptions(workspaceRoot, projectGet);

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
    let unchanged = 0;
    for (const filePath of schema.files) {
      const outcome = await writeTypesFor(schema, filePath, config, pathOptions);
      if (!outcome) continue;
      if (outcome.changed) written++;
      else unchanged++;
    }
    // 0.3.70:报告区分「写入 / 未变」——未变的文件本就不该计入产出
    vscode.window.showInformationMessage(
      unchanged > 0
        ? vscode.l10n.t(
            'Proto Utils: Generated {0} files under {1}/ ({2} unchanged)',
            written,
            pathOptions.outputDir,
            unchanged,
          )
        : vscode.l10n.t('Proto Utils: Generated {0} files under {1}/', written, pathOptions.outputDir),
    );
  });

  context.subscriptions.push(cmd, allCmd);
}

function readConfig(projectGet: (key: string) => unknown): CodeGenConfig {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  // 分层(0.3.82):项目文件 .proto-utils/settings.json 命中值(全键 codeGen.*)压过 VS Code settings
  const get = <T>(key: string, dflt: T): T => {
    const v = projectGet(`codeGen.${key}`);
    return v !== undefined && v !== null ? (v as T) : cfg.get<T>(key, dflt);
  };
  // int64Style 非法值兜底 'number'(package.json 枚举之外的旧配置)
  const int64StyleRaw = get<string>('int64Style', 'number');
  const int64Style = int64StyleRaw === 'bigint' || int64StyleRaw === 'string' ? int64StyleRaw : 'number';
  return {
    enumStyle: get<'enum' | 'union'>('enumStyle', 'enum'),
    optionalMessageFields: get<boolean>('optionalMessageFields', true),
    optionalScalarFields: get<boolean>('optionalScalarFields', false),
    fieldNaming: get<'camelCase' | 'preserve'>('fieldNaming', 'camelCase'),
    oneofStyle: get<'optional' | 'union'>('oneofStyle', 'optional'),
    importExtension: get<'ts' | 'none'>('importExtension', 'ts'),
    int64Style,
  };
}

function readPathOptions(workspaceRoot: string, projectGet: (key: string) => unknown): OutputPathOptions {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  // 分层同 readConfig:项目文件 codeGen.* 压过 VS Code settings
  const pick = <T>(key: string, dflt: T): T => {
    const v = projectGet(`codeGen.${key}`);
    return v !== undefined && v !== null ? (v as T) : cfg.get<T>(key, dflt);
  };
  return {
    workspaceRoot,
    outputDir: pick<string>('outputDir', 'generated'),
    pathMapping: pick<'package' | 'file'>('pathMapping', 'file'),
  };
}
