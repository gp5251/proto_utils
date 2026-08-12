import path from 'node:path';

/**
 * 调用面配置(用户 spec 的配置面):VS Code settings → RunnerConfig。
 * 纯函数,vscode 适配层在 extension.ts;键名不带 'protoUtils.' 前缀,
 * 由调用方用 workspace.getConfiguration('protoUtils').get 传入。
 */

export interface RunnerConfig {
  /** gRPC 服务器地址 host:port */
  server: string;
  /** proto 目录绝对路径;无工作区且未配置时为 null(调用方负责报错提示) */
  protoDir: string | null;
}

const DEFAULT_SERVER = 'localhost:50051';

/** 目录扫描排除集:names 命中任一路径段,paths 命中规范化绝对路径自身或子目录。 */
export interface ScanExcludes {
  readonly names: ReadonlySet<string>;
  readonly paths: readonly string[];
}

export const EMPTY_SCAN_EXCLUDES: ScanExcludes = { names: new Set(), paths: [] };

/** win32 路径比较不分大小写;统一规范化为比较形态。 */
function normalizeForCompare(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * protoUtils.scan.excludeDirs → ScanExcludes。
 * 条目三种形态:裸目录名(命中任一路径段,如 "out-vscode")、
 * 含分隔符的相对路径(相对 workspace 根)、绝对路径。
 */
export function resolveScanExcludes(get: (key: string) => unknown, workspaceRoot: string | undefined): ScanExcludes {
  const raw = get('scan.excludeDirs');
  if (!Array.isArray(raw)) return EMPTY_SCAN_EXCLUDES;
  const names = new Set<string>();
  const paths: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v) continue;
    if (path.isAbsolute(v) || v.includes('/') || v.includes('\\')) {
      paths.push(normalizeForCompare(path.isAbsolute(v) ? v : path.join(workspaceRoot ?? '', v)));
    } else {
      names.add(process.platform === 'win32' ? v.toLowerCase() : v);
    }
  }
  return { names, paths };
}

/** 目录是否被排除:name 为当前路径段,fullPath 为该目录的绝对路径。 */
export function isDirExcluded(name: string, fullPath: string, excludes: ScanExcludes): boolean {
  const key = process.platform === 'win32' ? name.toLowerCase() : name;
  if (excludes.names.has(key)) return true;
  const full = normalizeForCompare(fullPath);
  return excludes.paths.some((p) => full === p || full.startsWith(p + path.sep));
}

export function resolveRunnerConfig(
  get: (key: string) => unknown,
  workspaceRoot: string | undefined,
): RunnerConfig {
  const rawServer = get('runner.server');
  const server = typeof rawServer === 'string' && rawServer.trim() !== '' ? rawServer.trim() : DEFAULT_SERVER;

  const rawDir = get('runner.protoDir');
  const dir = typeof rawDir === 'string' ? rawDir.trim() : '';
  let protoDir: string | null;
  if (dir === '') {
    protoDir = workspaceRoot ?? null;
  } else {
    protoDir = path.isAbsolute(dir) ? path.normalize(dir) : path.join(workspaceRoot ?? '', dir);
  }

  return { server, protoDir };
}
