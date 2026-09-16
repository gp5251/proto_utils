import * as grpc from '@grpc/grpc-js';
import fs from 'node:fs';
import { l10n } from 'vscode';
import { CallOptions, CallResult, StreamHandlers, StreamHandle } from './types';
import type { MetadataEntry, TlsSettings } from '../config';
import type { ScanExcludes } from '../config';
import { findProtoFileForService } from './protoLoader';
import { getPackageDefinition } from './protoCache';
import { formatGrpcError } from '../utils/formatGrpcError';

/**
 * TlsSettings → grpc 通道凭据。未启用 TLS → insecure;启用 → createSsl,
 * PEM 文件就地读取,读失败抛带路径的中文错(经 formatGrpcError 上抛到调用面)。
 * clientCert/clientKey 必须成对配置,只给一个直接抛错(0.3.35)。
 */
export function buildChannelCredentials(tls: TlsSettings): grpc.ChannelCredentials {
  if (!tls.enabled) {
    return grpc.credentials.createInsecure();
  }
  const { clientCert, clientKey } = tls;
  if ((clientCert === null) !== (clientKey === null)) {
    throw new Error(
      l10n.t(
        'Incomplete TLS configuration: runner.tlsClientCert and runner.tlsClientKey must be set together (only one is set)',
      ),
    );
  }
  const readPem = (file: string, label: string): Buffer => {
    try {
      return fs.readFileSync(file);
    } catch {
      throw new Error(l10n.t('Failed to read TLS {0} file: {1} (check runner.tls* path settings)', label, file));
    }
  };
  return grpc.credentials.createSsl(
    tls.rootCert ? readPem(tls.rootCert, l10n.t('root certificate')) : null,
    clientKey ? readPem(clientKey, l10n.t('client private key')) : null,
    clientCert ? readPem(clientCert, l10n.t('client certificate')) : null,
  );
}

/**
 * 连通性探测(0.3.54):裸 grpc.Client + waitForReady,只验证 deadline 内通道可达,
 * 不依赖任何服务定义。工作台顶栏连接状态点的数据源;不可达/超时一律 false,不抛。
 */
export async function probeServerConnectivity(
  address: string,
  credentials: grpc.ChannelCredentials,
  timeoutMs = 1500,
): Promise<boolean> {
  const client = new grpc.Client(address, credentials);
  try {
    await new Promise<void>((resolve, reject) => {
      client.waitForReady(Date.now() + timeoutMs, (err?: Error) => (err ? reject(err) : resolve()));
    });
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

type UnaryCall = (
  req: unknown,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  cb: (err: unknown, res: unknown) => void,
) => grpc.ClientUnaryCall;
type ServerStreamCall = (req: unknown, metadata: grpc.Metadata) => grpc.ClientReadableStream<unknown>;
type ClientMethod = UnaryCall | ServerStreamCall;

interface StreamFlags {
  requestStream: boolean;
  responseStream: boolean;
}

type ResolveOutcome =
  | { error: string }
  | {
      client: Record<string, unknown>;
      methodFn: ClientMethod;
      streamFlags: StreamFlags | undefined;
    };

const NOOP_STREAM_HANDLE: StreamHandle = { cancel: () => undefined };

/** CallOptions.metadata → grpc.Metadata;无条目也给空实例,调用点签名保持固定。 */
function buildGrpcMetadata(entries: MetadataEntry[] | undefined): grpc.Metadata {
  const md = new grpc.Metadata();
  for (const entry of entries ?? []) {
    md.add(entry.key, entry.value);
  }
  return md;
}

/** grpc.Metadata → 展示用条目。保留同 key 多值;-bin 二进制键 base64 化(Buffer 无法进 JSON/页面)。 */
function metadataToEntries(md: grpc.Metadata | undefined): MetadataEntry[] {
  if (!md) {
    return [];
  }
  const out: MetadataEntry[] = [];
  for (const key of Object.keys(md.getMap())) {
    for (const value of md.get(key)) {
      out.push({ key, value: typeof value === 'string' ? value : Buffer.from(value).toString('base64') });
    }
  }
  return out;
}

export class GrpcClient {
  private readonly credentials: grpc.ChannelCredentials | undefined;
  /** 一元调用超时毫秒数;0/未配置 = 不限(不设 grpc deadline) */
  private readonly timeoutMs: number;
  /** 服务文件扫描排除集;与服务列表扫描同源(0.3.44),缺省不排除 */
  private readonly scanExcludes: ScanExcludes;

  constructor(
    private address: string,
    options?: { credentials?: grpc.ChannelCredentials; timeoutMs?: number; scanExcludes?: ScanExcludes },
  ) {
    this.credentials = options?.credentials;
    this.timeoutMs = options?.timeoutMs ?? 0;
    this.scanExcludes = options?.scanExcludes ?? { names: new Set(), paths: [] };
  }

  async call(protoDir: string, options: CallOptions): Promise<CallResult> {
    const start = Date.now();
    // 提到 try 外:调用失败(含 deadline)时 catch 里也要关通道,避免泄漏
    let client: Record<string, unknown> | undefined;

    try {
      const resolved = this.resolveCall(protoDir, options.service, options.method);
      if ('error' in resolved) {
        return {
          status: 'error',
          error: resolved.error,
          durationMs: Date.now() - start,
        };
      }

      client = resolved.client;
      const { methodFn, streamFlags } = resolved;

      // ADR-0007:client/bidi 流不做,撞上 requestStream 方法给明确错误
      if (streamFlags?.requestStream) {
        this.safeClose(client);
        return {
          status: 'error',
          error: l10n.t('Method "{0}" uses client streaming; only unary and server-streaming calls are supported', options.method),
          durationMs: Date.now() - start,
        };
      }
      if (streamFlags?.responseStream) {
        this.safeClose(client);
        return {
          status: 'error',
          error: l10n.t('Method "{0}" is a server-streaming method; use the streaming call instead', options.method),
          durationMs: Date.now() - start,
        };
      }

      // 超时走 grpc deadline(服务端可见的硬截止,DEADLINE_EXCEEDED 由 formatGrpcError 格式化);
      // timeoutMs=0 不设 deadline。metadata 恒传实例,grpc-js 的 4 参重载不需要移位判断。
      const callOptions: grpc.CallOptions = {};
      if (this.timeoutMs > 0) {
        callOptions.deadline = Date.now() + this.timeoutMs;
      }
      // 响应 headers/trailers 经 ClientUnaryCall 的 metadata/status 事件到达,与回调独立
      let responseHeaders: grpc.Metadata | undefined;
      let responseTrailers: grpc.Metadata | undefined;
      const response = await new Promise<unknown>((resolve, reject) => {
        const call = (methodFn as UnaryCall).call(
          client,
          options.request,
          buildGrpcMetadata(options.metadata),
          callOptions,
          (err: unknown, res: unknown) => {
            if (err) reject(err);
            else resolve(res);
          },
        );
        call.on('metadata', (md: grpc.Metadata) => {
          responseHeaders = md;
        });
        call.on('status', (s: grpc.StatusObject) => {
          responseTrailers = s.metadata;
        });
      });

      this.safeClose(client);

      return {
        status: 'ok',
        data: response,
        durationMs: Date.now() - start,
        responseHeaders: metadataToEntries(responseHeaders),
        responseTrailers: metadataToEntries(responseTrailers),
      };
    } catch (e: unknown) {
      if (client) this.safeClose(client);
      return {
        status: 'error',
        error: formatGrpcError(e, this.address),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * ADR-0007:服务端流。流式方法直接调 methodFn.call(client, request) 拿
   * ClientReadableStream,data/error/end 事件转发;不设总超时。
   * 返回的 cancel() 调 stream.cancel();取消引发的 CANCELLED 错误按正常结束上报。
   */
  callServerStream(
    protoDir: string,
    options: CallOptions,
    handlers: StreamHandlers,
  ): StreamHandle {
    const start = Date.now();

    let resolved: ResolveOutcome;
    try {
      resolved = this.resolveCall(protoDir, options.service, options.method);
    } catch (e: unknown) {
      handlers.onError(formatGrpcError(e, this.address));
      return NOOP_STREAM_HANDLE;
    }
    if ('error' in resolved) {
      handlers.onError(resolved.error);
      return NOOP_STREAM_HANDLE;
    }

    const { client, methodFn, streamFlags } = resolved;

    if (streamFlags?.requestStream) {
      this.safeClose(client);
      handlers.onError(l10n.t('Method "{0}" uses client/bidi streaming; only unary and server-streaming calls are supported', options.method));
      return NOOP_STREAM_HANDLE;
    }
    if (!streamFlags?.responseStream) {
      this.safeClose(client);
      handlers.onError(l10n.t('Method "{0}" is not a server-streaming method', options.method));
      return NOOP_STREAM_HANDLE;
    }

    let stream: grpc.ClientReadableStream<unknown>;
    try {
      // ADR-0007:流式不设总超时(deadline);metadata 与一元同构造
      stream = (methodFn as ServerStreamCall).call(client, options.request, buildGrpcMetadata(options.metadata));
    } catch (e: unknown) {
      this.safeClose(client);
      handlers.onError(formatGrpcError(e, this.address));
      return NOOP_STREAM_HANDLE;
    }

    let cancelled = false;
    let settled = false;
    // 响应 headers 先于首个 data;trailers 随 status 事件在 end/error 之前到达
    stream.on('metadata', (md: grpc.Metadata) => {
      if (!cancelled) {
        handlers.onHeaders?.(metadataToEntries(md));
      }
    });
    stream.on('status', (s: grpc.StatusObject) => {
      if (!cancelled && !settled) {
        handlers.onTrailers?.(metadataToEntries(s.metadata));
      }
    });
    stream.on('data', (data: unknown) => {
      if (!cancelled) {
        handlers.onData(data);
      }
    });
    stream.on('error', (err: unknown) => {
      if (settled) return;
      settled = true;
      this.safeClose(client);
      const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
      if (cancelled && code === grpc.status.CANCELLED) {
        handlers.onEnd(Date.now() - start);
        return;
      }
      handlers.onError(formatGrpcError(err, this.address));
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      this.safeClose(client);
      handlers.onEnd(Date.now() - start);
    });

    return {
      cancel: () => {
        if (!settled) {
          cancelled = true;
          stream.cancel();
        }
      },
    };
  }

  /**
   * findProtoFileForService → getPackageDefinition → findServiceClass →
   * resolveMethod 的公共链;一元与服务端流共用。解析失败不抛,返回 { error }。
   */
  private resolveCall(protoDir: string, serviceName: string, methodName: string): ResolveOutcome {
    const protoFile = findProtoFileForService(protoDir, serviceName, this.scanExcludes);
    if (!protoFile) {
      return { error: l10n.t('Service "{0}" not found in proto definitions', serviceName) };
    }

    const packageDefinition = getPackageDefinition(protoFile, protoDir);
    const grpcObj = grpc.loadPackageDefinition(packageDefinition);

    const ServiceClass = this.findServiceClass(grpcObj, serviceName);

    if (!ServiceClass) {
      return { error: l10n.t('Service "{0}" not found in proto definitions', serviceName) };
    }

    const client = new ServiceClass(
      this.address,
      this.credentials ?? grpc.credentials.createInsecure()
    ) as Record<string, unknown>;

    const resolved = this.resolveMethod(client, methodName);

    if (!resolved) {
      this.safeClose(client);
      const available = this.getAvailableMethods(client);
      return { error: l10n.t('Method "{0}" not found. Available: {1}', methodName, available.join(', ')) };
    }

    return {
      client,
      methodFn: resolved.methodFn,
      streamFlags: this.findMethodFlags(ServiceClass, methodName),
    };
  }

  /**
   * 服务类定位:serviceName 按点分段逐级导航(大小写不敏感),全限定名
   * pkg.Service 精确落到所属包——跨包同短名服务不再靠首个命中瞎撞(0.3.44)。
   * 单段(裸短名)分段导航失败时退回旧的任意深度递归,兼容历史入口。
   */
  private findServiceClass(
    obj: Record<string, unknown>,
    serviceName: string
  ): (new (...args: unknown[]) => unknown) | null {
    const segmented = this.locateServiceClass(obj, serviceName.split('.'));
    if (segmented || serviceName.includes('.')) return segmented;
    return this.findServiceClassDeep(obj, serviceName);
  }

  private locateServiceClass(
    obj: Record<string, unknown>,
    segments: string[]
  ): (new (...args: unknown[]) => unknown) | null {
    const [head, ...rest] = segments;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'object' && typeof value !== 'function') continue;
      if (value === null) continue;
      const candidate = value as Record<string, unknown>;
      if (key !== head && key.toLowerCase() !== head.toLowerCase()) continue;

      if (rest.length === 0) {
        if (typeof value === 'function' && 'service' in candidate) {
          return value as unknown as (new (...args: unknown[]) => unknown);
        }
        continue;
      }
      if (typeof value === 'object') {
        const found = this.locateServiceClass(candidate, rest);
        if (found) return found;
      }
    }
    return null;
  }

  /** 旧路径:裸短名在任意命名空间深度上的首个命中(历史行为兜底)。 */
  private findServiceClassDeep(
    obj: Record<string, unknown>,
    serviceName: string
  ): (new (...args: unknown[]) => unknown) | null {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'object' && typeof value !== 'function') continue;
      if (value === null) continue;

      const candidate = value as Record<string, unknown>;

      if (
        typeof value === 'function' &&
        'service' in candidate
      ) {
        if (key === serviceName || key.toLowerCase() === serviceName.toLowerCase()) {
          return value as unknown as (new (...args: unknown[]) => unknown);
        }
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        const found = this.findServiceClassDeep(value as Record<string, unknown>, serviceName);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * grpc-js exposes RPC names from proto-loader (keepCase: false).
   * Naive camelCase breaks acronyms: ListFBVariableRequest → listFBVariableRequest,
   * but the client stub uses listFbVariableRequest. Match exact, then case-insensitive.
   */
  private resolveMethod(
    client: Record<string, unknown>,
    methodName: string,
  ): { methodFn: ClientMethod; methodKey: string } | null {
    const available = this.getAvailableMethods(client);
    const naiveKey = methodName.charAt(0).toLowerCase() + methodName.slice(1);

    for (const key of [methodName, naiveKey]) {
      const fn = client[key];
      if (typeof fn === 'function') {
        return { methodFn: fn as ClientMethod, methodKey: key };
      }
    }

    const target = methodName.toLowerCase();
    const matched = available.find(key => key.toLowerCase() === target);
    if (matched && typeof client[matched] === 'function') {
      return { methodFn: client[matched] as ClientMethod, methodKey: matched };
    }

    return null;
  }

  /**
   * 从 ServiceClass.service(grpc.ServiceDefinition,键为 proto 声明名)读
   * proto-loader MethodDefinition 的 requestStream/responseStream;先精确后大小写不敏感。
   */
  private findMethodFlags(
    ServiceClass: new (...args: unknown[]) => unknown,
    methodName: string,
  ): StreamFlags | undefined {
    if (!('service' in ServiceClass)) {
      return undefined;
    }
    const service: unknown = ServiceClass.service;
    if (typeof service !== 'object' || service === null) {
      return undefined;
    }
    const target = methodName.toLowerCase();
    for (const [name, def] of Object.entries(service)) {
      if (name !== methodName && name.toLowerCase() !== target) {
        continue;
      }
      if (typeof def !== 'object' || def === null) {
        return undefined;
      }
      return {
        requestStream: 'requestStream' in def && def.requestStream === true,
        responseStream: 'responseStream' in def && def.responseStream === true,
      };
    }
    return undefined;
  }

  private getAvailableMethods(client: Record<string, unknown>): string[] {
    const methods: string[] = [];
    for (let proto = Object.getPrototypeOf(client); proto !== null; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key !== 'constructor' && typeof client[key] === 'function' && !methods.includes(key)) {
          methods.push(key);
        }
      }
    }
    return methods;
  }

  private safeClose(client: Record<string, unknown>): void {
    const c = client as { close?: () => void };
    if (typeof c.close === 'function') {
      c.close();
    }
  }
}
