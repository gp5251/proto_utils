import * as grpc from '@grpc/grpc-js';
import { l10n } from 'vscode';
import { CallOptions, CallResult, StreamHandlers, StreamHandle } from './types';
import { findProtoFileForService } from './protoLoader';
import { getPackageDefinition } from './protoCache';
import { formatGrpcError } from '../utils/formatGrpcError';

type UnaryCall = (req: unknown, cb: (err: unknown, res: unknown) => void) => void;
type ServerStreamCall = (req: unknown) => grpc.ClientReadableStream<unknown>;
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

export class GrpcClient {
  constructor(private address: string) {}

  async call(protoDir: string, options: CallOptions): Promise<CallResult> {
    const start = Date.now();

    try {
      const resolved = this.resolveCall(protoDir, options.service, options.method);
      if ('error' in resolved) {
        return {
          status: 'error',
          error: resolved.error,
          durationMs: Date.now() - start,
        };
      }

      const { client, methodFn, streamFlags } = resolved;

      // ADR-0007:client/bidi 流不做,撞上 requestStream 方法给明确错误
      if (streamFlags?.requestStream) {
        this.safeClose(client);
        return {
          status: 'error',
          error: `Method "${options.method}" 是客户端流方法,调用面仅支持一元与服务端流`,
          durationMs: Date.now() - start,
        };
      }
      if (streamFlags?.responseStream) {
        this.safeClose(client);
        return {
          status: 'error',
          error: `Method "${options.method}" 是服务端流方法,请改用流式调用`,
          durationMs: Date.now() - start,
        };
      }

      let timeout: NodeJS.Timeout | undefined;
      try {
        const response = await Promise.race([
          new Promise<unknown>((resolve, reject) => {
            (methodFn as UnaryCall).call(client, options.request, (err: unknown, res: unknown) => {
              if (err) reject(err);
              else resolve(res);
            });
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('gRPC 请求超时 (15s)')), 15000);
          }),
        ]);

        this.safeClose(client);

        return {
          status: 'ok',
          data: response,
          durationMs: Date.now() - start,
        };
      } finally {
        // race 输赢已定,超时定时器必须清掉——宿主是长寿命的扩展进程,不是跑完就退的 CLI
        clearTimeout(timeout);
      }
    } catch (e: unknown) {
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
      handlers.onError(`Method "${options.method}" 是客户端/双向流方法,调用面仅支持一元与服务端流`);
      return NOOP_STREAM_HANDLE;
    }
    if (!streamFlags?.responseStream) {
      this.safeClose(client);
      handlers.onError(`Method "${options.method}" 不是服务端流方法`);
      return NOOP_STREAM_HANDLE;
    }

    let stream: grpc.ClientReadableStream<unknown>;
    try {
      stream = (methodFn as ServerStreamCall).call(client, options.request);
    } catch (e: unknown) {
      this.safeClose(client);
      handlers.onError(formatGrpcError(e, this.address));
      return NOOP_STREAM_HANDLE;
    }

    let cancelled = false;
    let settled = false;
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
    const protoFile = findProtoFileForService(protoDir, serviceName);
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
      grpc.credentials.createInsecure()
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

  private findServiceClass(
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
        const found = this.findServiceClass(value as Record<string, unknown>, serviceName);
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
