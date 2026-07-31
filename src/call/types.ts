export interface RpcConfig {
  server: string;
  protoDir: string;
  generatedDir: string;
  port: number;
}

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
}

export type CallResult = CallOk | CallError;

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
