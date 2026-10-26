import path from 'node:path';
import { SEQUENCE_DIR, isNotFound, realFs, type SequenceStoreFs } from './runner/sequenceStore';

/**
 * 项目级配置(0.3.82):工作区文件 .proto-utils/settings.json,扁平点分键、
 * 不带 'protoUtils.' 前缀(与 resolveRunnerConfig 的 get 键名一致),形如
 *   { "runner.protoDir": "proto", "codeGen.outputDir": "src/generated" }
 * 优先级:项目文件 > VS Code settings > 默认(服务器地址除外:顶栏编辑持久化值最高)。
 * 进版本库、团队共享,与 sequences.json / environments.json 同目录同惯例(ADR-0014)。
 * fs 与 workspaceRoot 构造注入,单测用内存替身(SequenceStoreFs 同款最小面;仅 type import,不拖 runner bundle)。
 */
export const SETTINGS_FILE = 'settings.json';

/** 模板值一律 = package.json 声明的默认值:创建文件本身不改变任何行为,改哪个键哪个生效。 */
const TEMPLATE: Record<string, unknown> = {
  'runner.protoDir': '',
  'runner.timeoutMs': 15000,
  'runner.connProbeIntervalMs': 5000,
  'runner.metadata': [],
  'scan.excludeDirs': [],
  'codeGen.outputDir': 'generated',
  'codeGen.enumStyle': 'enum',
  'codeGen.optionalMessageFields': true,
  'codeGen.optionalScalarFields': false,
  'codeGen.fieldNaming': 'camelCase',
  'codeGen.pathMapping': 'file',
  'codeGen.importExtension': 'ts',
  'codeGen.oneofStyle': 'optional',
  'codeGen.int64Style': 'number',
};

export class ProjectConfig {
  private readonly file: string;
  private data: Record<string, unknown> = {};
  private lastError: string | undefined;

  /** 文件存在但解析失败时的原因;此时缓存为空(缺失文件不算错)。 */
  get error(): string | undefined {
    return this.lastError;
  }

  /** 当前配置文件绝对路径(供命令打开/警告展示)。 */
  get filePath(): string {
    return this.file;
  }

  constructor(
    workspaceRoot: string,
    private readonly fs: SequenceStoreFs = realFs,
  ) {
    this.file = path.join(workspaceRoot, SEQUENCE_DIR, SETTINGS_FILE);
  }

  async reload(): Promise<void> {
    this.data = {};
    this.lastError = undefined;
    let text: string;
    try {
      text = await this.fs.readFile(this.file);
    } catch (err) {
      if (!isNotFound(err)) this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.lastError = `${SETTINGS_FILE} is not valid JSON`;
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.lastError = `${SETTINGS_FILE} top level must be an object`;
      return;
    }
    this.data = parsed as Record<string, unknown>;
  }

  /** 命中返回值原样(可能是 null/false 等);未命中 undefined。分层方用 ?? 组合(null 也回退)。 */
  get(key: string): unknown {
    return this.data[key];
  }

  /** 文件不存在时写入模板;返回文件路径供编辑器打开(Environments.ensureFile 同款)。 */
  async ensureFile(): Promise<string> {
    try {
      await this.fs.readFile(this.file);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.fs.mkdir(path.dirname(this.file));
      await this.fs.writeFile(this.file, JSON.stringify(TEMPLATE, null, 2) + '\n');
      await this.reload();
    }
    return this.file;
  }
}
