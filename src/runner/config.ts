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
