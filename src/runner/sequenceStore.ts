import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * 命名调用序列的持久化(0.3.59,ADR-0012):存工作区文件 .proto-utils/sequences.json,
 * 进版本库、可团队共享。宿主侧模块(不进 webview),故可用 node 内建。
 * fs 与 workspaceRoot 均构造注入,单测用内存替身,不碰磁盘。
 */

/** 序列里的一步:自带入参快照(mode 决定用 values 还是 jsonText),与工作台实时表单脱钩。 */
export interface SequenceStep {
  service: string;
  method: string;
  /** 入参编辑模式:沿用工作台 表单|JSON 双模式(ADR-0010 JSON5 松输入)。 */
  mode: 'form' | 'json';
  /** form 模式的入参快照。 */
  values?: Record<string, unknown>;
  /** json 模式的入参文本。 */
  jsonText?: string;
  /** 该步是否服务端流(决定引擎走 callUnary 还是 callServerStream)。 */
  responseStream: boolean;
}

/** 一条命名调用序列。 */
export interface Sequence {
  name: string;
  steps: SequenceStep[];
}

/** 存储文件损坏/格式错时抛;缺失文件不算错(视为空列表)。 */
export class SequenceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceStoreError';
  }
}

/** 最小 fs 面:注入替身即可脱离磁盘单测。 */
export interface SequenceStoreFs {
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

const realFs: SequenceStoreFs = {
  readFile: (file) => readFile(file, 'utf8'),
  writeFile: (file, data) => writeFile(file, data, 'utf8'),
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
};

/** 相对工作区根的存储文件路径(固定,ADR-0012)。 */
export const SEQUENCE_DIR = '.proto-utils';
export const SEQUENCE_FILE = 'sequences.json';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 归一化一步:字段缺失给安全默认,类型不对判非法返回 null(逐条容错,坏步跳过不炸整份)。 */
function normalizeStep(raw: unknown): SequenceStep | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.service !== 'string' || typeof raw.method !== 'string') return null;
  const mode = raw.mode === 'json' ? 'json' : 'form';
  const step: SequenceStep = {
    service: raw.service,
    method: raw.method,
    mode,
    responseStream: raw.responseStream === true,
  };
  if (isRecord(raw.values)) step.values = raw.values;
  if (typeof raw.jsonText === 'string') step.jsonText = raw.jsonText;
  return step;
}

/** 归一化一条序列:name 非空 + steps 为数组才收;坏步逐条剔除。 */
function normalizeSequence(raw: unknown): Sequence | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return null;
  if (!Array.isArray(raw.steps)) return null;
  const steps: SequenceStep[] = [];
  for (const s of raw.steps) {
    const step = normalizeStep(s);
    if (step) steps.push(step);
  }
  return { name: raw.name, steps };
}

/**
 * 校验并归一化一份来路不明的工作序列(webview postMessage 入站)。
 * 与持久化同一套规则:非法返回 null;坏步剔除。name 允许为空(未命名的工作序列)。
 */
export function parseSequence(raw: unknown): Sequence | null {
  if (!isRecord(raw) || !Array.isArray(raw.steps)) return null;
  const steps: SequenceStep[] = [];
  for (const s of raw.steps) {
    const step = normalizeStep(s);
    if (step) steps.push(step);
  }
  const name = typeof raw.name === 'string' ? raw.name : '';
  return { name, steps };
}

export class SequenceStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(
    workspaceRoot: string,
    private readonly fs: SequenceStoreFs = realFs,
  ) {
    this.dir = path.join(workspaceRoot, SEQUENCE_DIR);
    this.file = path.join(this.dir, SEQUENCE_FILE);
  }

  /** 当前存储文件绝对路径(供 UI 展示/日志)。 */
  get filePath(): string {
    return this.file;
  }

  /**
   * 读全部序列。文件缺失 → [];JSON 不可解析或顶层非数组 → 抛 SequenceStoreError
   * (不静默返空,免得下次 save 覆盖掉用户数据);单条坏序列逐条剔除。
   */
  async list(): Promise<Sequence[]> {
    let text: string;
    try {
      text = await this.fs.readFile(this.file);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SequenceStoreError(`${path.basename(this.file)} is not valid JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new SequenceStoreError(`${path.basename(this.file)} top level must be an array`);
    }
    const out: Sequence[] = [];
    for (const item of parsed) {
      const seq = normalizeSequence(item);
      if (seq) out.push(seq);
    }
    return out;
  }

  /** 按名取一条;不存在返回 null。 */
  async get(name: string): Promise<Sequence | null> {
    const all = await this.list();
    return all.find((s) => s.name === name) ?? null;
  }

  /** 存一条:同名覆盖,否则追加。写前确保目录存在。 */
  async save(seq: Sequence): Promise<void> {
    const normalized = normalizeSequence(seq);
    if (!normalized) throw new SequenceStoreError('Sequence is missing name or steps');
    const all = await this.list();
    const idx = all.findIndex((s) => s.name === normalized.name);
    if (idx >= 0) all[idx] = normalized;
    else all.push(normalized);
    await this.write(all);
  }

  /** 按名删除;返回是否删掉了存在的条目。 */
  async delete(name: string): Promise<boolean> {
    const all = await this.list();
    const next = all.filter((s) => s.name !== name);
    if (next.length === all.length) return false;
    await this.write(next);
    return true;
  }

  private async write(all: Sequence[]): Promise<void> {
    await this.fs.mkdir(this.dir);
    await this.fs.writeFile(this.file, JSON.stringify(all, null, 2));
  }
}

/** ENOENT 判定:缺失文件是正常空态,其余读错误上抛。 */
function isNotFound(err: unknown): boolean {
  return isRecord(err) && (err as { code?: unknown }).code === 'ENOENT';
}
