import type { MetadataEntry, TlsSettings } from '../config';

/**
 * 「复制为 grpcurl」命令拼装(0.3.78):纯函数,入参全部是已解析的值(环境变量已替换)。
 * ponytail: 只做 POSIX shell 单引号转义(bash/zsh 可直接粘贴);Windows cmd/PowerShell 需手改引号。
 */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface GrpcurlInput {
  server: string;
  /** pkg.Service/Method 的服务全限定名 */
  serviceFullName: string;
  method: string;
  request: Record<string, unknown>;
  metadata?: MetadataEntry[];
  tls: TlsSettings;
  /** 一元调用超时毫秒;0 或流式 = 不加 -max-time */
  timeoutMs: number;
  /** proto 根目录(-import-path);与 protoFile 一起给,grpcurl 不依赖服务端反射 */
  protoDir?: string;
  /** 服务定义文件相对 protoDir 的路径(/ 分隔);未知时省略 -proto,退回服务端反射 */
  protoFile?: string;
}

export function buildGrpcurlCommand(input: GrpcurlInput): string {
  const args: string[] = ['grpcurl'];
  if (!input.tls.enabled) {
    args.push('-plaintext');
  } else {
    if (input.tls.rootCert) args.push(`-cacert ${shellQuote(input.tls.rootCert)}`);
    if (input.tls.clientCert) args.push(`-cert ${shellQuote(input.tls.clientCert)}`);
    if (input.tls.clientKey) args.push(`-key ${shellQuote(input.tls.clientKey)}`);
  }
  if (input.protoDir && input.protoFile) {
    args.push(`-import-path ${shellQuote(input.protoDir)}`, `-proto ${shellQuote(input.protoFile)}`);
  }
  for (const h of input.metadata ?? []) {
    args.push(`-H ${shellQuote(`${h.key}: ${h.value}`)}`);
  }
  args.push(`-d ${shellQuote(JSON.stringify(input.request))}`);
  if (input.timeoutMs > 0) {
    args.push(`-max-time ${input.timeoutMs / 1000}`);
  }
  args.push(shellQuote(input.server), shellQuote(`${input.serviceFullName}/${input.method}`));
  return args.join(' \\\n  ');
}
