import { CallOptions, CallResult, FieldInfo, StreamHandlers } from './core/types';
import { GrpcClient, buildChannelCredentials } from './core/grpcClient';
import { ServiceRegistry, SerializedMethod } from './serviceRegistry';
import { buildRequestFromValues } from './utils/formParser';
import type { MetadataEntry, TlsSettings } from './config';
import JSON5 from 'json5';

export type { StreamHandlers, StreamHandle } from './core/types';

/** GrpcClient 的调用面;工厂注入以便单测替换真实 grpc 通讯(spec: GrpcClient 工厂注入) */
export interface GrpcTransport {
  call(protoDir: string, options: CallOptions): Promise<CallResult>;
  callServerStream(
    protoDir: string,
    options: CallOptions,
    handlers: StreamHandlers,
  ): { cancel(): void };
}

/**
 * 与 rpc_runner routes/call.ts 的响应体同构(字段名冻结)。
 * values 恒为空对象:rpc_runner 的 values 只在服务端渲染表单回显路径填充,
 * JSON 调用路径(webview 等价物)本就返回 {}。
 */
export interface CallResultPayload {
  service: string;
  method: string;
  requestType: string;
  responseType: string;
  fields: FieldInfo[];
  values: Record<string, string>;
  result: CallResult;
  resultBody: string;
  /** 0.3.38:响应 headers/trailers(仅 result.status === 'ok' 时填充;错误路径缺省) */
  responseHeaders?: MetadataEntry[];
  responseTrailers?: MetadataEntry[];
}

export interface CallRunner {
  callUnary(
    service: string,
    method: string,
    values: Record<string, unknown>,
    metadata?: MetadataEntry[],
  ): Promise<CallResultPayload>;
  callServerStream(
    service: string,
    method: string,
    values: Record<string, unknown>,
    handlers: StreamHandlers,
    metadata?: MetadataEntry[],
  ): { cancel(): void };
}

/** routes/call.ts JSON 分支:有 schema 走字段解析;无 schema 时兜底 _raw JSON。 */
function buildRequestObject(fields: FieldInfo[], values: Record<string, unknown>): Record<string, unknown> {
  if (fields.length === 0 && typeof values._raw === 'string') {
    try {
      const parsed: unknown = JSON5.parse(values._raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore invalid JSON
    }
    return {};
  }
  return buildRequestFromValues(fields, values);
}

export class GrpcCallRunner implements CallRunner {
  private readonly clientFactory: (server: string) => GrpcTransport;

  constructor(
    private readonly server: string,
    private readonly protoDir: string,
    private readonly registry: ServiceRegistry,
    clientFactory?: (server: string) => GrpcTransport,
    /** 通道级默认:TLS 凭据与一元超时(0.3.35);不传则保持 insecure 无超时 */
    callDefaults?: { tls: TlsSettings; timeoutMs: number },
  ) {
    this.clientFactory =
      clientFactory ??
      (callDefaults
        ? (addr) =>
            new GrpcClient(addr, {
              credentials: buildChannelCredentials(callDefaults.tls),
              timeoutMs: callDefaults.timeoutMs,
            })
        : (addr) => new GrpcClient(addr));
  }

  async callUnary(
    service: string,
    method: string,
    values: Record<string, unknown>,
    metadata?: MetadataEntry[],
  ): Promise<CallResultPayload> {
    const m = await this.findMethod(service, method);
    const fields: FieldInfo[] = m?.requestFields ?? [];
    const requestObj = buildRequestObject(fields, values);

    const client = this.clientFactory(this.server);
    const result = await client.call(this.protoDir, { service, method, request: requestObj, metadata });

    return {
      service,
      method,
      requestType: m?.requestType || 'unknown',
      responseType: m?.responseType || 'unknown',
      fields,
      values: {},
      result,
      resultBody: result.status === 'ok'
        ? JSON.stringify(result.data, null, 2)
        : result.error,
      responseHeaders: result.status === 'ok' ? (result.responseHeaders ?? []) : undefined,
      responseTrailers: result.status === 'ok' ? (result.responseTrailers ?? []) : undefined,
    };
  }

  callServerStream(
    service: string,
    method: string,
    values: Record<string, unknown>,
    handlers: StreamHandlers,
    metadata?: MetadataEntry[],
  ): { cancel(): void } {
    const client = this.clientFactory(this.server);
    let handle: { cancel(): void } | null = null;
    let cancelled = false;

    void this.findMethod(service, method).then(m => {
      if (cancelled) {
        return;
      }
      const requestObj = buildRequestObject(m?.requestFields ?? [], values);
      handle = client.callServerStream(this.protoDir, { service, method, request: requestObj, metadata }, handlers);
      if (cancelled) {
        handle.cancel();
      }
    }).catch((err: unknown) => {
      handlers.onError(err instanceof Error ? err.message : String(err));
    });

    return {
      cancel: () => {
        cancelled = true;
        handle?.cancel();
      },
    };
  }

  private async findMethod(service: string, method: string): Promise<SerializedMethod | null> {
    const { services } = await this.registry.load(this.protoDir);
    // CodeLens 发全限定名(pkg.Service),工作台下拉发裸名——两者都认
    const svc = services.find(s => s.name === service || s.fullName === service);
    return svc?.methods.find(item => item.name === method) ?? null;
  }
}
