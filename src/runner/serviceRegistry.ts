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
   * 作用域文件(规范化绝对路径;0.3.83 引入,0.3.86 由集合改替换式单文件):
   * CodeLens「▶ 调用」点击的当前文件。非 null 时服务列表**只**含该文件的接口,不扫
   * protoDir;顶栏来源标识可点清除。只收 protoDir 范围外的文件——范围内的由扫描覆盖,
   * 列表本就是全量(收窄它反而砍掉「浏览全部服务」的用法)。
   */
  private scoped: string | null = null;

  constructor(private readonly excludes: ScanExcludes = EMPTY_SCAN_EXCLUDES) {}

  /** 服务文件扫描排除集;调用面(GrpcClient 找服务定义文件)与列表扫描共用同一份。 */
  get scanExcludes(): ScanExcludes {
    return this.excludes;
  }

  /** 当前作用域文件;null = 未收窄,列表为 protoDir 全量。调用面据此与列表保持同口径。 */
  get pinnedFile(): string | null {
    return this.scoped;
  }

  /**
   * 按 CodeLens 点击的文件设定服务列表作用域(0.3.86,替换式):
   * - 文件存在且在 protoDir 外 → 钉住它,列表只含它的接口,上一个作用域自动失效;
   * - 文件在 protoDir 内 → **解除**钉住,列表回到全量。这是「目录内不收窄」的必然推论:
   *   否则点完目录内文件的 ▶,列表会卡在先前那个目录外文件上,自相矛盾;
   * - 文件不存在(未保存的 untitled 文档) → 不动既有作用域,免得把用户无故踢回全量。
   *
   * 只清服务列表缓存(load 按新作用域重算),刻意不动 serviceFileCache 与 protoCache:
   * 前者由解析侧的作用域优先短路,后者自带 mtime:size 指纹门;盲清会让下次 load 全量
   * loadSync 整棵树,正是 0.3.48 修过的扩展宿主卡顿(见 invalidate 注释)。
   *
   * @returns 作用域是否变化;变化时调用方需重载服务列表。
   */
  scopeToProtoFile(protoFile: string, protoDir: string): boolean {
    const abs = path.resolve(protoFile);
    // 存在性守卫:未保存的 untitled 文档同样带 protoFile,钉住一个不存在的路径毫无用处,
    // 只会白报一次「变化」并触发无谓重载;也不能借此顶掉既有作用域。
    if (!fs.existsSync(abs)) {
      return false;
    }
    // 空 protoDir(无工作区文件夹)等于「没有范围」,必须跳过免钉判定:path.resolve('') === cwd,
    // 否则仓库内任何文件都会被判成「已在扫描范围内」而永不钉住,服务列表恒空。
    const insideDir = protoDir.trim() !== '' && isInsideDir(abs, protoDir);
    return this.setScoped(insideDir ? null : abs);
  }

  /** 解除作用域(顶栏来源标识的清除入口)。@returns 是否变化;未钉住时 false,不引发重载。 */
  unpin(): boolean {
    return this.setScoped(null);
  }

  private setScoped(next: string | null): boolean {
    if (this.scoped === next) {
      return false;
    }
    this.scoped = next;
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
    if (this.scoped) {
      // 作用域态(0.3.86):只加载该文件,不扫 protoDir。protoDir 存在与否与此时的列表
      // 无关,故也不报它的缺失/非目录错(并集语义下要报,收窄后就成了无关噪声)。
      //
      // 不额外追加 include 根:proto-loader 的 resolver 按 includeDirs 顺序取首个可读命中,
      // 全落空才回退到「origin 文件所在目录」拼接(util.js addIncludePathResolver),故追加
      // dirname(作用域文件) 与回退等价(唯一效果是少一条 include-path 警告,走 stderr 不进
      // UI);追加更高层祖先反而会抢在回退之前命中、可能把 import 绑到错误的同名文件。
      // 跨目录 import 根仍是 runner.protoDir 的职责。
      if (fs.existsSync(this.scoped)) {
        protoFiles = [this.scoped];
      } else {
        errors.push(l10n.t('Scoped proto file no longer exists: {0}', this.scoped));
      }
    } else if (!fs.existsSync(protoDir)) {
      errors.push(l10n.t('protoDir not found: {0}', protoDir));
    } else if (!fs.statSync(protoDir).isDirectory()) {
      errors.push(l10n.t('protoDir is not a directory: {0}', protoDir));
    } else {
      protoFiles = scanProtoFiles(protoDir, this.excludes);
    }

    const result = loadProtoDefinitions(protoFiles, protoDir);
    const scopedImportHint = this.scoped && result.errors.some((e) => e.includes('ENOENT'))
      ? [l10n.t('Cross-directory import failed. Configure protoUtils.runner.protoDir to the import root, then click Refresh.')]
      : [];
    const loaded: ServicesLoadResult = {
      services: serializeServicesForClient(result.services),
      errors: [...errors, ...result.errors, ...scopedImportHint],
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
