import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';

import { readProtoFile } from './protoEncoding';
import { EMPTY_SCAN_EXCLUDES, isDirExcluded, ScanExcludes } from '../runner/config';

/**
 * 扫描时跳过的目录名(构建产物 + 历史约定)。
 * 三处同步维护同一清单:ProtoFrontend.scan / SymbolIndex 的 findFiles 排除 glob /
 * protoLoader.walkDir。不排除会扫进 out/ 等构建产物里的 proto 拷贝,
 * 与 src 源文件撞 duplicate name,保存诊断即失败(autoshop_vscode 现场)。
 */
export const SCAN_EXCLUDED_DIRS = [
  'node_modules',
  'generated',
  '__fixtures__',
  'out',
  'out-vscode',
  'dist',
  'build',
  'bin',
  'obj',
  'target',
] as const;

const GOOGLE_PROTO_PREFIX = 'google/protobuf/';

/** Root.getBundledFileName + common 查表的公开 API 等价物(内建 google/protobuf/* 类型)。非内建名返回 null——与 loadInto 的 bundled 判定同源,analysis 闭包遍历共用。 */
export function bundledGoogleJson(target: string): protobuf.INamespace | null {
  const idx = target.indexOf(GOOGLE_PROTO_PREFIX);
  return idx === -1 ? null : protobuf.common.get(target.slice(idx));
}

/** protobufjs 运行时往 parse 出的对象上挂 filename(d.ts 未声明)——in 窄化;buildSchema 与 analysis/missingImport 共用。 */
export function filenameOf(obj: protobuf.ReflectionObject): string {
  return 'filename' in obj && typeof obj.filename === 'string' ? obj.filename : '';
}

/**
 * import 解析器工厂:includeDirs(protoc -I 语义)优先,找不到则退回导入文件所在目录
 * (protobufjs 默认 resolvePath 语义)——深层布局里同目录裸 import 很常见,
 * 如 src/vs/platform/autoshop/common 里写 import "var_table.proto"。
 * 找不到返回 null;ProtoFrontend.resolveImport 在其上包装抛错,
 * analysis/missingImport 的闭包 BFS 则跳过 null 边。
 */
export function createImportResolver(includeDirs: string[]): (target: string, origin?: string) => string | null {
  return (target, origin) => {
    if (path.isAbsolute(target) && fs.existsSync(target)) return path.normalize(target);
    for (const dir of includeDirs) {
      const candidate = path.join(path.resolve(dir), target);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (origin) {
      const candidate = path.join(path.dirname(origin), target);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  };
}

/** parse.filename 运行时挂载但 d.ts 未声明 —— 结构化标注出该属性,不做内联断言;toProtoLoadError 靠它提取出错文件名。 */
function parsePreservingFilename(content: string, root: protobuf.Root, file: string): protobuf.IParserResult {
  const parse: typeof protobuf.parse & { filename?: string } = protobuf.parse;
  parse.filename = file;
  return parse(content, root, { keepCase: true });
}

/**
 * 语义前端(ADR-0002):扩展内唯一有权解析 proto 语义的组件。
 * 基于 protobufjs,keepCase 恒为 true —— 本模块服务 emitter/诊断平面,
 * 它们需要声明时的原始字段名;调用面(grpc-js)另行用
 * @grpc/proto-loader(keepCase:false)按需加载,互不共享 Root。
 */

export interface ProtoSchema {
  /** 全部 proto 已解析并合并进同一个 Root。 */
  root: protobuf.Root;
  /** 全限定类型名(无前导点,含嵌套与 service)-> 声明它的文件绝对路径。 */
  declarations: ReadonlyMap<string, string>;
  /** 参与本次加载的全部 .proto 文件绝对路径,排序确定。 */
  files: string[];
}

export class ProtoLoadError extends Error {
  constructor(
    message: string,
    readonly file?: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'ProtoLoadError';
  }
}

/** 递归遍历反射树(深入所有 Namespace),对每个对象与其父命名空间回调。 */
export function walkReflection(
  root: protobuf.Root,
  visit: (obj: protobuf.ReflectionObject, parent: protobuf.NamespaceBase) => void,
): void {
  const walk = (ns: protobuf.NamespaceBase): void => {
    for (const obj of ns.nestedArray) {
      visit(obj, ns);
      if (obj instanceof protobuf.Namespace) walk(obj);
    }
  };
  walk(root);
}

/** 扫描结果不做缓存——load() 每次都重新发现文件,靠 invalidate() 触发。 */
export class ProtoFrontend {
  private cached: { schema: ProtoSchema } | { error: ProtoLoadError } | null = null;
  /**
   * 上次构建时的文件指纹(mtimeMs:size,0.3.45):load() 先 stat 比对,
   * 未变更直接复用缓存——工作台 onLoadSettled 每次都会走到这里,
   * 此前配合触发器的盲 invalidate 造成「每次开面板都全量重析」的风暴。
   * stat 同时覆盖 watcher 盲区(protoDir 在工作区之外)的变更。
   */
  private stamps: ReadonlyMap<string, string> | null = null;
  private readonly importResolver: (target: string, origin?: string) => string | null;

  constructor(
    readonly includeDirs: string[],
    private readonly excludes: ScanExcludes = EMPTY_SCAN_EXCLUDES,
  ) {
    // includeDirs 构造期即定:缓存一份 resolver,loadInto 每条 import 边复用,不逐边新建闭包
    this.importResolver = createImportResolver(includeDirs);
  }

  scan(): string[] {
    // includeDirs 重叠(如 workspace 与其内的 protoDir)会产生重复绝对路径,去重防 self-conflict(0.3.13)
    const seen = new Set<string>();
    const results: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // 用已知的 dir 拼 fullPath,不取 Dirent.parentPath:后者 Node ≥20.1 才有,
        // engines 声明的 VS Code 1.85(内建 Node 18.15)上不存在,会直接 TypeError
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            !entry.name.startsWith('.') &&
            !(SCAN_EXCLUDED_DIRS as readonly string[]).includes(entry.name) &&
            !isDirExcluded(entry.name, full, this.excludes)
          ) {
            walk(full);
          }
        } else if (entry.name.endsWith('.proto')) {
          const key = process.platform === 'win32' ? full.toLowerCase() : full;
          if (!seen.has(key)) {
            seen.add(key);
            results.push(full);
          }
        }
      }
    };
    for (const dir of this.includeDirs) walk(path.resolve(dir));
    return results.sort();
  }

  load(): ProtoSchema {
    if (!this.cached || !this.stampsMatch()) {
      try {
        this.cached = { schema: this.buildSchema() };
      } catch (err) {
        this.cached = { error: toProtoLoadError(err) };
      }
    }
    if ('error' in this.cached) throw this.cached.error;
    return this.cached.schema;
  }

  invalidate(): void {
    this.cached = null;
    this.stamps = null;
  }

  /** 指纹比对:文件集与逐文件 mtime:size 全等才算未变更;scan 失败视为失配(重建时抛真实错误)。 */
  private stampsMatch(): boolean {
    if (!this.stamps) return false;
    let files: string[];
    try {
      files = this.scan();
    } catch {
      return false;
    }
    if (files.length !== this.stamps.size) return false;
    try {
      for (const file of files) {
        const st = fs.statSync(file);
        if (this.stamps.get(file) !== `${st.mtimeMs}:${st.size}`) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  private recordStamps(files: string[]): void {
    const stamps = new Map<string, string>();
    for (const file of files) {
      const st = fs.statSync(file);
      stamps.set(file, `${st.mtimeMs}:${st.size}`);
    }
    this.stamps = stamps;
  }

  private buildSchema(): ProtoSchema {
    const root = new protobuf.Root();
    const files = this.scan();
    const loaded = new Set<string>();
    for (const file of files) this.loadInto(root, file, false, loaded);
    this.recordStamps(files);

    // resolveAll 遇首个未解析类型即抛(级联报错)——逐 Field/Method 单独 resolve
    // 收集全部失败一次报齐,诊断平面才能把每一处坏引用都飘红。
    // 注意 Field/Method 不在 nestedArray(分挂 fieldsArray/methodsArray),walkReflection 走不到。
    const resolutionErrors = new Set<string>();
    const tryResolve = (obj: protobuf.Field | protobuf.Method): void => {
      try {
        obj.resolve();
      } catch (err) {
        resolutionErrors.add(err instanceof Error ? err.message : String(err));
      }
    };
    walkReflection(root, (obj) => {
      if (obj instanceof protobuf.Type) {
        for (const field of obj.fieldsArray) tryResolve(field);
      } else if (obj instanceof protobuf.Service) {
        for (const method of obj.methodsArray) tryResolve(method);
      }
    });
    if (resolutionErrors.size > 0) throw new Error([...resolutionErrors].join('\n'));
    root.resolveAll();

    const declarations = new Map<string, string>();
    walkReflection(root, (obj) => {
      if (
        obj instanceof protobuf.Type ||
        obj instanceof protobuf.Enum ||
        obj instanceof protobuf.Service
      ) {
        declarations.set(obj.fullName.slice(1), filenameOf(obj));
      }
    });
    return { root, declarations, files };
  }

  /**
   * Root.loadSync 的编码感知替代:其同步路径硬编码 readFileSync(...).toString('utf8'),
   * 覆写 root.fetch 只对异步路径生效,只能自行跟随 import。
   * 语义对齐 protobufjs src/root.js 的 process/fetch:google 内建类型优先于路径解析、
   * 按解析后路径去重、weak import 读取失败静默跳过(resolveImport 找不到则照常抛错)。
   */
  private loadInto(root: protobuf.Root, target: string, weak: boolean, loaded: Set<string>, origin?: string): void {
    const bundled = bundledGoogleJson(target);
    const key = bundled ? target.slice(target.indexOf(GOOGLE_PROTO_PREFIX)) : this.resolveImport(target, origin);
    if (loaded.has(key)) return;
    loaded.add(key);

    if (bundled) {
      if (bundled.options) root.setOptions(bundled.options);
      if (bundled.nested) root.addJSON(bundled.nested);
      return;
    }

    let content: string;
    try {
      content = readProtoFile(key);
    } catch (err) {
      if (weak) return;
      throw err;
    }

    const parsed = parsePreservingFilename(content, root, key);
    for (const imp of parsed.imports ?? []) this.loadInto(root, imp, false, loaded, key);
    for (const weakImp of parsed.weakImports ?? []) this.loadInto(root, weakImp, true, loaded, key);
  }

  /**
   * import 解析:委托缓存的 createImportResolver(同一套 includeDirs/origin 语义),
   * 找不到时抛错——loadInto 的调用契约要求硬失败;闭包遍历等容忍场景用 createImportResolver 直取 null。
   */
  private resolveImport(target: string, origin?: string): string {
    const resolved = this.importResolver(target, origin);
    if (resolved) return resolved;
    throw new Error(`import not found: ${target}${origin ? `(由 ${path.basename(origin)} 导入)` : ''}`);
  }
}

function toProtoLoadError(err: unknown): ProtoLoadError {
  const message = err instanceof Error ? err.message : String(err);
  const located = /^(.*?)\s*\((.+\.proto), line (\d+)\)$/.exec(message);
  if (located) {
    return new ProtoLoadError(located[1], located[2], Number(located[3]));
  }
  return new ProtoLoadError(message);
}
