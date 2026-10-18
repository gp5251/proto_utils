import path from 'node:path';
import { SEQUENCE_DIR, SequenceStoreFs, isNotFound, realFs } from './sequenceStore';
import type { HistoryState } from './history';

/**
 * 环境与变量(0.3.78):工作区文件 .proto-utils/environments.json,形如
 *   { "dev": { "host": "localhost:50051", "token": "abc" }, "prod": { ... } }
 * 当前激活环境存 workspaceState;变量在服务器地址、Headers、入参里以 {{name}} 引用,
 * 发送前由宿主替换(placeholder.resolveVars)。值一律按字符串处理。
 */
export const ENV_FILE = 'environments.json';
const ACTIVE_KEY = 'runner.environment';

export interface EnvSnapshot {
  names: string[];
  active: string | null;
  variables: Record<string, string>;
  /** 文件存在但解析失败时的原因;此时 names 为空 */
  error?: string;
}

const TEMPLATE = {
  dev: { host: 'localhost:50051' },
  staging: { host: 'staging.example.com:443' },
};

export class Environments {
  private envs: Record<string, Record<string, string>> = {};
  private error: string | undefined;
  readonly filePath: string;

  constructor(
    workspaceRoot: string,
    private readonly state: HistoryState,
    private readonly fs: SequenceStoreFs = realFs,
  ) {
    this.filePath = path.join(workspaceRoot, SEQUENCE_DIR, ENV_FILE);
  }

  async reload(): Promise<void> {
    this.envs = {};
    this.error = undefined;
    let text: string;
    try {
      text = await this.fs.readFile(this.filePath);
    } catch (err) {
      if (!isNotFound(err)) this.error = err instanceof Error ? err.message : String(err);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.error = `${ENV_FILE} is not valid JSON`;
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.error = `${ENV_FILE} top level must be an object`;
      return;
    }
    for (const [name, vars] of Object.entries(parsed)) {
      if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) continue;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) {
        if (v !== null && typeof v !== 'object') out[k] = String(v);
      }
      this.envs[name] = out;
    }
  }

  private activeName(): string | null {
    const a = this.state.get(ACTIVE_KEY);
    return typeof a === 'string' && Object.prototype.hasOwnProperty.call(this.envs, a) ? a : null;
  }

  vars(): Record<string, string> {
    const a = this.activeName();
    return a ? this.envs[a] : {};
  }

  snapshot(): EnvSnapshot {
    const snap: EnvSnapshot = { names: Object.keys(this.envs), active: this.activeName(), variables: this.vars() };
    if (this.error) snap.error = this.error;
    return snap;
  }

  async setActive(name: string | null): Promise<void> {
    await this.state.update(ACTIVE_KEY, name);
  }

  /** 文件不存在时写入模板;返回文件路径供编辑器打开。 */
  async ensureFile(): Promise<string> {
    try {
      await this.fs.readFile(this.filePath);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.fs.mkdir(path.dirname(this.filePath));
      await this.fs.writeFile(this.filePath, JSON.stringify(TEMPLATE, null, 2) + '\n');
      await this.reload();
    }
    return this.filePath;
  }
}
