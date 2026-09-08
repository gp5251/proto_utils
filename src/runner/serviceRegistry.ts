import fs from 'node:fs';
import { l10n } from 'vscode';
import { FieldInfo, ServiceInfo } from './core/types';
import { clearServiceFileCache, loadProtoDefinitions, scanProtoFiles } from './core/protoLoader';
import { EMPTY_SCAN_EXCLUDES, ScanExcludes } from './config';
import { flattenSchemaRows, SchemaRow } from './utils/schemaRows';

/**
 * serializeServicesForClient 的方法条目,字段名冻结(与 rpc_runner
 * routes/home.ts 同构 + ADR-0007 新增 requestStream/responseStream)。
 */
export interface SerializedMethod {
  name: string;
  requestType: string;
  responseType: string;
  requestStream: boolean;
  responseStream: boolean;
  requestFields: FieldInfo[];
  responseSchemaRows: SchemaRow[];
}

export interface SerializedService {
  name: string;
  fullName: string;
  methods: SerializedMethod[];
}

export type ServicesPayload = SerializedService[];

export interface ServicesLoadResult {
  services: ServicesPayload;
  errors: string[];
}

export function serializeServicesForClient(services: ServiceInfo[]): ServicesPayload {
  return services.map(s => ({
    name: s.name,
    fullName: s.fullName,
    methods: s.methods.map(m => ({
      name: m.name,
      requestType: m.requestType,
      responseType: m.responseType,
      requestStream: m.requestStream,
      responseStream: m.responseStream,
      requestFields: m.requestFields,
      responseSchemaRows: flattenSchemaRows(m.responseFields),
    })),
  }));
}

/**
 * 服务加载/错误收集(rpc_runner routes/home.ts 的 Express 无关部分)。
 * 磁盘缓存/指纹不搬,仅内存缓存;invalidate() 同时清 protoLoader 层缓存,
 * 供 VS Code 文件 watcher 触发刷新。
 */
export class ServiceRegistry {
  private cached: ServicesLoadResult | null = null;
  private cachedDir: string | null = null;

  constructor(private readonly excludes: ScanExcludes = EMPTY_SCAN_EXCLUDES) {}

  /** 服务文件扫描排除集;调用面(GrpcClient 找服务定义文件)与列表扫描共用同一份。 */
  get scanExcludes(): ScanExcludes {
    return this.excludes;
  }

  async load(protoDir: string): Promise<ServicesLoadResult> {
    if (this.cached && this.cachedDir === protoDir) {
      return this.cached;
    }

    const errors: string[] = [];
    let protoFiles: string[] = [];
    if (!fs.existsSync(protoDir)) {
      errors.push(l10n.t('protoDir not found: {0}', protoDir));
    } else if (!fs.statSync(protoDir).isDirectory()) {
      errors.push(l10n.t('protoDir is not a directory: {0}', protoDir));
    } else {
      protoFiles = scanProtoFiles(protoDir, this.excludes);
    }

    const result = loadProtoDefinitions(protoFiles, protoDir);
    const loaded: ServicesLoadResult = {
      services: serializeServicesForClient(result.services),
      errors: [...errors, ...result.errors],
    };
    this.cached = loaded;
    this.cachedDir = protoDir;
    return loaded;
  }

  invalidate(): void {
    this.cached = null;
    this.cachedDir = null;
    // 只清服务文件缓存(无指纹门,必须显式失效);protoCache 保留——它自带
    // mtime:size 指纹门(0.3.45),load 时逐文件 stat 比对,未变的复用、改动的
    // 自动重析。此前经 resetProtoLoaderCache 盲清 protoCache,让每次 proto 变更后
    // 的 reload 都全量 loadSync 整棵树(扩展宿主被同步解析块占死);保留指纹门后
    // reload 变为增量(0.3.48 性能)。彻底重置(含 protoCache)仍可用 resetProtoLoaderCache。
    clearServiceFileCache();
  }
}
