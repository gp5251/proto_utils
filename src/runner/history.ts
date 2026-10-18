import type { MetadataEntry } from './config';

/**
 * 请求历史(0.3.78):每次一元/服务端流调用结束记一条,存 workspaceState(按工作区隔离、不进版本库)。
 * values/metadata 存未替换环境变量的原文——恢复后切环境仍能复用。
 */
export interface HistoryEntry {
  service: string;
  method: string;
  values: Record<string, unknown>;
  metadata: MetadataEntry[];
  ts: number;
  ok: boolean;
  durationMs: number;
}

/** vscode.Memento 的最小面,单测用 Map 替身。 */
export interface HistoryState {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

const KEY = 'runner.history';
// ponytail: 固定上限 100 条、全量读写 Memento;需要按方法分桶/搜索时再换存储结构
export const HISTORY_LIMIT = 100;

export class CallHistory {
  constructor(private readonly state: HistoryState) {}

  list(): HistoryEntry[] {
    const raw = this.state.get(KEY);
    return Array.isArray(raw) ? (raw as HistoryEntry[]) : [];
  }

  /** 新条目在前;与最近一条入参完全相同时只刷新时间与结果,免连点刷屏。 */
  async add(entry: HistoryEntry): Promise<HistoryEntry[]> {
    const all = this.list();
    const head = all[0];
    const same =
      head &&
      head.service === entry.service &&
      head.method === entry.method &&
      JSON.stringify(head.values) === JSON.stringify(entry.values) &&
      JSON.stringify(head.metadata) === JSON.stringify(entry.metadata);
    const next = (same ? [entry, ...all.slice(1)] : [entry, ...all]).slice(0, HISTORY_LIMIT);
    await this.state.update(KEY, next);
    return next;
  }
}
