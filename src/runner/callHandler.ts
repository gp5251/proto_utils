import { CallOptions, CallResult, DuplexHandle, FieldInfo, StreamHandlers } from './core/types';
import { GrpcClient, buildChannelCredentials } from './core/grpcClient';
import { findProtoFileForService } from './core/protoLoader';
import { ServiceRegistry, SerializedMethod } from './serviceRegistry';
import { buildRequestFromValues } from './utils/formParser';
import { buildGrpcurlCommand } from './utils/grpcurl';
import { isInsideDir, type MetadataEntry, type TlsSettings } from './config';
import JSON5 from 'json5';
import path from 'node:path';

export type { StreamHandlers, StreamHandle } from './core/types';

/** GrpcClient 的调用面;工厂注入以便单测替换真实 grpc 通讯(spec: GrpcClient 工厂注入) */
export interface GrpcTransport {
  call(protoDir: string, options: CallOptions): Promise<CallResult>;
  callServerStream(
    protoDir: string,
    options: CallOptions,
    handlers: StreamHandlers,
  ): { cancel(): void };
  /** 0.3.78(ADR-0013):client-stream / bidi;测试替身可不实现 */
  openDuplex?(protoDir: string, options: Omit<CallOptions, 'request'>, handlers: StreamHandlers): DuplexHandle;
}

/** 调用面运行时配置快照:getConfig() 每次调用前现读。 */
export interface RunnerRuntimeConfig {
  /** gRPC 服务器地址 host:port */
  server: string;
  /** proto 目录绝对路径(import 解析的 includeDir) */
  protoDir: string;
  tls: TlsSettings;
  /** 一元调用超时毫秒数;0 = 不限 */
  timeoutMs: number;
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
  /** 0.3.78(ADR-0013):打开 client-stream / bidi 会话;send 的 values 与 callUnary 同形态 */
  openClientStream?(
    service: string,
    method: string,
    handlers: StreamHandlers,
    metadata?: MetadataEntry[],
  ): ClientStreamHandle;
  /** 0.3.78:生成等价 grpcurl 命令(values/metadata 须已替换环境变量) */
  grpcurlCommand?(
    service: string,
    method: string,
    values: Record<string, unknown>,
    metadata?: MetadataEntry[],
  ): Promise<string>;
}

export interface ClientStreamHandle {
  send(values: Record<string, unknown>): void;
  halfClose(): void;
  cancel(): void;
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
  private readonly clientFactory: (cfg: RunnerRuntimeConfig) => GrpcTransport;

  constructor(
    /** 运行时配置源:每次调用入口现读,server/protoDir/TLS/超时改动即时生效(0.3.44) */
    private readonly getConfig: () => RunnerRuntimeConfig,
    private readonly registry: ServiceRegistry,
    clientFactory?: (cfg: RunnerRuntimeConfig) => GrpcTransport,
  ) {
    this.clientFactory =
      clientFactory ??
      ((cfg) =>
        new GrpcClient(cfg.server, {
          credentials: buildChannelCredentials(cfg.tls),
          timeoutMs: cfg.timeoutMs,
          // 与服务列表同一份排除集:陈旧拷贝目录不参与服务定义文件竞选(0.3.44)
          scanExcludes: this.registry.scanExcludes,
          // 钉住文件同步给调用面(0.3.83):列表能显示出来的目录外服务,也必须调得通
          pinnedFiles: this.registry.pinnedFiles,
        }));
  }

  async callUnary(
    service: string,
    method: string,
    values: Record<string, unknown>,
    metadata?: MetadataEntry[],
  ): Promise<CallResultPayload> {
    const cfg = this.getConfig();
    const m = await this.findMethod(cfg.protoDir, service, method);
    const fields: FieldInfo[] = m?.requestFields ?? [];
    const requestObj = buildRequestObject(fields, values);

    const result = await this.clientFactory(cfg).call(cfg.protoDir, { service, method, request: requestObj, metadata });

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
    // 入口快照:本次流的 findMethod 与真正发起都用同一份配置,中途改动不影响进行中的流
    const cfg = this.getConfig();
    const client = this.clientFactory(cfg);
    let handle: { cancel(): void } | null = null;
    let cancelled = false;

    void this.findMethod(cfg.protoDir, service, method).then(m => {
      if (cancelled) {
        return;
      }
      const requestObj = buildRequestObject(m?.requestFields ?? [], values);
      handle = client.callServerStream(cfg.protoDir, { service, method, request: requestObj, metadata }, handlers);
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

  private async findMethod(protoDir: string, service: string, method: string): Promise<SerializedMethod | null> {
    return (await this.findTarget(protoDir, service, method)).method;
  }

  private async findTarget(
    protoDir: string,
    service: string,
    method: string,
  ): Promise<{ fullName: string | null; method: SerializedMethod | null }> {
    const { services } = await this.registry.load(protoDir);
    // CodeLens 发全限定名(pkg.Service),工作台下拉发裸名——两者都认
    const svc = services.find(s => s.name === service || s.fullName === service);
    return { fullName: svc?.fullName ?? null, method: svc?.methods.find(item => item.name === method) ?? null };
  }

  openClientStream(
    service: string,
    method: string,
    handlers: StreamHandlers,
    metadata?: MetadataEntry[],
  ): ClientStreamHandle {
    const cfg = this.getConfig();
    const client = this.clientFactory(cfg);
    // findMethod 就绪前的 send/halfClose 排队,就绪后按序冲刷
    type Op = (h: DuplexHandle, fields: FieldInfo[]) => void;
    const pending: Op[] = [];
    let handle: DuplexHandle | null = null;
    let fields: FieldInfo[] = [];
    let cancelled = false;
    const run = (op: Op): void => {
      if (handle) op(handle, fields);
      else pending.push(op);
    };

    void this.findMethod(cfg.protoDir, service, method).then(m => {
      if (cancelled) return;
      if (!client.openDuplex) throw new Error('transport does not support client streaming');
      fields = m?.requestFields ?? [];
      const h = client.openDuplex(cfg.protoDir, { service, method, metadata }, handlers);
      handle = h;
      for (const op of pending.splice(0)) op(h, fields);
    }).catch((err: unknown) => {
      handlers.onError(err instanceof Error ? err.message : String(err));
    });

    return {
      send: values => run((h, f) => h.write(buildRequestObject(f, values))),
      halfClose: () => run(h => h.end()),
      cancel: () => {
        cancelled = true;
        handle?.cancel();
      },
    };
  }

  async grpcurlCommand(
    service: string,
    method: string,
    values: Record<string, unknown>,
    metadata?: MetadataEntry[],
  ): Promise<string> {
    const cfg = this.getConfig();
    const t = await this.findTarget(cfg.protoDir, service, method);
    const fullName = t.fullName ?? service;
    const protoFile = findProtoFileForService(
      cfg.protoDir,
      fullName,
      this.registry.scanExcludes,
      this.registry.pinnedFiles,
    );
    const streaming = !!(t.method?.requestStream || t.method?.responseStream);

    // -import-path / -proto 的取法(0.3.83):定义文件在 protoDir 内则照旧给相对路径;
    // 钉住的目录外文件相对化会产出 ..\..\x.proto 这类粘不进 shell 的路径,改用文件
    // 自身目录作 import-path + 裸文件名作 proto,复制出去的命令才可直接执行。
    let importPath = cfg.protoDir;
    let relProto: string | undefined;
    if (protoFile) {
      if (isInsideDir(protoFile, cfg.protoDir)) {
        relProto = path.relative(cfg.protoDir, protoFile).split(path.sep).join('/');
      } else {
        importPath = path.dirname(protoFile);
        relProto = path.basename(protoFile);
      }
    }

    return buildGrpcurlCommand({
      server: cfg.server,
      serviceFullName: fullName,
      method,
      request: buildRequestObject(t.method?.requestFields ?? [], values),
      metadata,
      tls: cfg.tls,
      timeoutMs: streaming ? 0 : cfg.timeoutMs,
      protoDir: importPath,
      protoFile: relProto,
    });
  }
}
