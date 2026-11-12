import * as vscode from 'vscode';
import path from 'node:path';
import { ProtoFrontend, ProtoLoadError, ProtoSchema } from '../runtime/protoFrontend';
import {
  emit,
  createOutputPathResolver,
  createTypeResolver,
  findOutputConflict,
  hasEmittableTypes,
  schemaHasFile,
  CodeGenConfig,
  OutputConflict,
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

    const filePath = targetUri.fsPath;
    // 0.3.89:活动编辑器不是 proto 时直接说明,不再走到 include dirs 检查报误导错误
    if (!filePath.toLowerCase().endsWith('.proto')) {
      vscode.window.showErrorMessage(
        vscode.l10n.t('Proto Utils: {0} is not a .proto file.', path.basename(filePath)),
      );
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage(vscode.l10n.t('Proto Utils: No workspace folder open.'));
      return;
    }

    const schema = loadSchema();
    if (!schema) return;

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

    const config = readConfig(projectGet);
    const pathOptions = readPathOptions(workspaceRoot, projectGet);
    if (!pathOptions) return;

    // 0.3.89:单文件生成同样做输出碰撞预检——package 映射下同包 proto 写到同一个 .ts,
    // 此前只有批量命令拦截,单命令会静默覆盖另一个文件的产物
    const conflict = findOutputConflict(schema, pathOptions, filePath);
    if (conflict) {
      showOutputConflict(conflict, workspaceRoot);
      return;
    }

    let outcome: { outPath: string; relative: string; changed: boolean } | null;
    try {
      outcome = await writeTypesFor(schema, filePath, config, pathOptions);
    } catch (err) {
      // 0.3.89:写盘失败点名文件报错,不再抛未处理拒绝
      vscode.window.showErrorMessage(
        vscode.l10n.t('Proto Utils: Failed to generate {0}: {1}', path.basename(filePath), errMessage(err)),
      );
      return;
    }
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
    if (!pathOptions) return;

    // file 平铺模式下同名 proto(package 模式下同包文件)会映射到同一输出文件互相覆盖:先检测再动笔
    const conflict = findOutputConflict(schema, pathOptions);
    if (conflict) {
      showOutputConflict(conflict, workspaceRoot);
      return;
    }

    // 0.3.89:批量生成进可取消的进度通知;单文件写失败不中断整体,结束后汇总点名报错
    const targets = schema.files.filter((f) => hasEmittableTypes(schema, f));
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Proto Utils: Generating TypeScript types...'),
        cancellable: true,
      },
      async (progress, token) => {
        let written = 0;
        let unchanged = 0;
        const failures: string[] = [];
        let done = 0;
        for (const filePath of targets) {
          if (token.isCancellationRequested) break;
          done++;
          progress.report({ message: `${done}/${targets.length} ${path.basename(filePath)}` });
          try {
            const outcome = await writeTypesFor(schema, filePath, config, pathOptions);
            if (!outcome) continue;
            if (outcome.changed) written++;
            else unchanged++;
          } catch (err) {
            failures.push(`${path.basename(filePath)} (${errMessage(err)})`);
          }
        }
        if (token.isCancellationRequested) {
          vscode.window.showWarningMessage(
            vscode.l10n.t('Proto Utils: Generation cancelled — {0} files written before cancellation.', written),
          );
          return;
        }
        if (failures.length > 0) {
          vscode.window.showErrorMessage(
            vscode.l10n.t(
              'Proto Utils: Generated {0} files, {1} failed: {2}',
              written,
              failures.length,
              failures.join('; '),
            ),
          );
          return;
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
      },
    );
  });

  context.subscriptions.push(cmd, allCmd);
}

/** 0.3.89:输出撞名报错——两个命令共用同一文案,按序点名两个文件与撞到的输出路径。 */
function showOutputConflict(conflict: OutputConflict, workspaceRoot: string): void {
  vscode.window.showErrorMessage(
    vscode.l10n.t(
      'Proto Utils: Output path conflict — {0} and {1} both map to {2}.',
      path.basename(conflict.first),
      path.basename(conflict.second),
      path.relative(workspaceRoot, conflict.outPath),
    ),
  );
}

/** 未知异常 → 可读消息(Error 取 message,其余 String 化)。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 分层配置读取(0.3.82):项目文件 .proto-utils/settings.json 命中值(codeGen.*)压过 VS Code settings。 */
function codeGenConfig(projectGet: (key: string) => unknown): {
  get: <T>(key: string, dflt: T) => T;
  pickEnum: <T extends string>(key: string, dflt: T, allowed: readonly T[]) => T;
} {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  const get = <T>(key: string, dflt: T): T => {
    const v = projectGet(`codeGen.${key}`);
    return v !== undefined && v !== null ? (v as T) : cfg.get<T>(key, dflt);
  };
  // 0.3.89:枚举旋钮非法值兜底默认(package.json 枚举之外的旧配置/手改值不再透传进 emitter)
  const pickEnum = <T extends string>(key: string, dflt: T, allowed: readonly T[]): T => {
    const v = get<string>(key, dflt);
    return (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
  };
  return { get, pickEnum };
}

function readConfig(projectGet: (key: string) => unknown): CodeGenConfig {
  const { get, pickEnum } = codeGenConfig(projectGet);
  return {
    enumStyle: pickEnum('enumStyle', 'enum', ['enum', 'union'] as const),
    optionalMessageFields: get<boolean>('optionalMessageFields', true),
    optionalScalarFields: get<boolean>('optionalScalarFields', false),
    fieldNaming: pickEnum('fieldNaming', 'camelCase', ['camelCase', 'preserve'] as const),
    oneofStyle: pickEnum('oneofStyle', 'optional', ['optional', 'union'] as const),
    importExtension: pickEnum('importExtension', 'ts', ['ts', 'none'] as const),
    int64Style: pickEnum('int64Style', 'number', ['number', 'bigint', 'string'] as const),
  };
}

/** 读取路径选项;outputDir 非法(绝对路径/越出工作区)时报错并返回 null(0.3.89)。 */
function readPathOptions(workspaceRoot: string, projectGet: (key: string) => unknown): OutputPathOptions | null {
  const { get, pickEnum } = codeGenConfig(projectGet);
  const raw = get<string>('outputDir', 'generated');
  const outputDir = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'generated';
  if (path.isAbsolute(outputDir)) {
    vscode.window.showErrorMessage(
      vscode.l10n.t('Proto Utils: codeGen.outputDir must be a relative path (got {0}).', outputDir),
    );
    return null;
  }
  const norm = (p: string): string => {
    const n = path.normalize(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  const root = norm(workspaceRoot);
  const resolved = norm(path.resolve(workspaceRoot, outputDir));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    vscode.window.showErrorMessage(
      vscode.l10n.t('Proto Utils: codeGen.outputDir points outside the workspace: {0}', outputDir),
    );
    return null;
  }
  return {
    workspaceRoot,
    outputDir,
    pathMapping: pickEnum('pathMapping', 'file', ['file', 'package'] as const),
  };
}
