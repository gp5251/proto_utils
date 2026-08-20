import type { MetadataEntry } from '../config';

export interface ServiceInfo {
  name: string;
  fullName: string; // package.Service
  package: string;
  methods: MethodInfo[];
}

export interface MethodInfo {
  name: string;
  requestType: string;
  responseType: string;
  /** ADR-0007:来自 proto-loader MethodDefinition 同名字段 */
  requestStream: boolean;
  responseStream: boolean;
  requestFields: FieldInfo[];
  responseFields: FieldInfo[];
}

export interface EnumOption {
  name: string;
  number: number;
  comment?: string;
}

export interface FieldInfo {
  name: string;
  type: string;
  required: boolean;
  label: string;
  protoType: string;
  refType?: string;
  /** proto3 explicit `optional` keyword */
  optional?: boolean;
  comment?: string;
  enumValues?: EnumOption[];
  nestedFields?: FieldInfo[];
}

export interface CallOptions {
  /** Service name as it appears in the proto file (not full package.Service path) */
  service: string;
  method: string;
  request: Record<string, unknown>;
  /** 本次调用携带的请求 metadata(0.3.35) */
  metadata?: MetadataEntry[];
}

export type CallResult = CallOk | CallError;

/** ADR-0007 服务端流事件转发;onError/onEnd 之后不再有事件。 */
export interface StreamHandlers {
  onData(data: unknown): void;
  onError(message: string): void;
  onEnd(durationMs: number): void;
}

export interface StreamHandle {
  cancel(): void;
}

export interface CallOk {
  status: 'ok';
  data: unknown;
  durationMs: number;
}

export interface CallError {
  status: 'error';
  error: string;
  durationMs: number;
}
