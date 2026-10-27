import fs from 'node:fs';
import path from 'node:path';
import { l10n } from 'vscode';
import { FieldInfo, ServiceInfo } from './core/types';
import { clearServiceFileCache, loadProtoDefinitions, scanProtoFiles } from './core/protoLoader';
import { EMPTY_SCAN_EXCLUDES, isInsideDir, ScanExcludes } from './config';
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
  /**
   * 钉住的 proto 文件(规范化绝对路径,0.3.83):CodeLens「▶ 调用」点击的当前文件。
   * 只收 protoDir 范围外的文件——范围内的本就由扫描覆盖,钉住纯属多余且会白白失效缓存。
   */
  private readonly pinned = new Set<string>();

  constructor(private readonly excludes: ScanExcludes = EMPTY_SCAN_EXCLUDES) {}

  /** 服务文件扫描排除集;调用面(GrpcClient 找服务定义文件)与列表扫描共用同一份。 */
  get scanExcludes(): ScanExcludes {
    return this.excludes;
  }

  /**
   * 钉住文件清单(0.3.83)。调用面据此做「钉住优先」的服务定义文件解析:
   * 目录外的服务在 protoDir 里扫不到,不优先短路就会报 Service not found。
   */
  get pinnedFiles(): string[] {
    return [...this.pinned];
  }

  /**
   * 钉住一个 proto 文件,使其不必落在 runner.protoDir 内也能进服务列表并被调用
   * (0.3.83,CodeLens 入口:点哪个文件就能调哪个文件)。
   * 已在 protoDir 内或已钉过则不动——热路径零开销,服务列表缓存原样复用。
   *
   * 只清服务列表缓存(load 会并入钉住文件重算),刻意不动 serviceFileCache 与 protoCache:
   * 前者由解析侧的钉住优先短路,后者自带 mtime:size 指纹门;盲清会让下次 load 全量
   * loadSync 整棵树,正是 0.3.48 修过的扩展宿主卡顿(见 invalidate 注释)。
   *
   * @returns 钉住集是否变化;调用方据此决定要不要重载服务列表。
   */
  pin(protoFile: string, protoDir: string): boolean {
    const abs = path.resolve(protoFile);
    if (this.pinned.has(abs)) {
      return false;
    }
    // 空 protoDir(无工作区文件夹)等于「没有范围」,必须跳过免钉判定:path.resolve('') === cwd,
    // 否则仓库内任何文件都会被判成「已在扫描范围内」而永不钉住,服务列表恒空。
    if (protoDir.trim() !== '' && isInsideDir(abs, protoDir)) {
      return false;
    }
    // 存在性守卫:未保存的 untitled 文档同样带 protoFile,钉住一个不存在的路径毫无用处,
    // 只会让每次点击都白报一次「变化」并触发无谓的服务列表重载。
    if (!fs.existsSync(abs)) {
      return false;
    }
    this.pinned.add(abs);
    this.cached = null;
    this.cachedDir = null;
    return true;
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

    // 钉住文件并入(0.3.83):protoDir 缺失、配窄或不含该文件时,服务列表仍有条目。
    // pin 已挡掉 protoDir 内的文件,故两者按定义互斥;includes 只防同一路径的不同写法。
    //
    // 不额外追加 include 根:proto-loader 的 resolver 按 includeDirs 顺序取首个可读命中,
    // 全落空才回退到「origin 文件所在目录」拼接(util.js addIncludePathResolver)。故把
    // dirname(钉住文件) 追加进去,解析结果与回退路径完全一致,唯一效果是少一条
    // "not found in any of the include paths" 警告(该警告本就对目录内文件也常发,走 stderr
    // 不进 UI);而追加更高层祖先会抢在 origin 回退之前命中,可能把 import 解析到错误的
    // 同名文件。权衡下不加——真需要跨目录 import 根,那是 runner.protoDir 的职责。
    for (const file of this.pinned) {
      if (fs.existsSync(file) && !protoFiles.includes(file)) {
        protoFiles.push(file);
      }
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

  /**
   * 当前缓存的载荷(0.3.70 启用):仅当 protoDir 与入参一致时返回,否则 null。
   * 不触发加载——供工作台面板创建时内嵌进 HTML,避免重开面板首帧闪 loading
   * (retainContextWhenHidden 只保隐藏态;面板销毁后重开必然走创建路径)。
   */
  peek(protoDir: string): ServicesPayload | null {
    return this.cached && this.cachedDir === protoDir ? this.cached.services : null;
  }

  invalidate(): void {
    this.cached = null;
    this.cachedDir = null;
    // 只清服务文件缓存(无指纹门,必须显式失效);protoCache 保留——它自带
    // mtime:size 指纹门(0.3.45,0.3.77 扩到 import 闭包),load 时逐闭包成员 stat
    // 比对,未变的复用、改动的(含被 import 文件)自动重析。此前经
    // resetProtoLoaderCache 盲清 protoCache,让每次 proto 变更后的
    // reload 都全量 loadSync 整棵树(扩展宿主被同步解析块占死);保留指纹门后
    // reload 变为增量(0.3.48 性能)。彻底重置(含 protoCache)仍可用 resetProtoLoaderCache。
    clearServiceFileCache();
  }
}
