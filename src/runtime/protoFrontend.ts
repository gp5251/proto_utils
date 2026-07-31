import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';

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

  constructor(readonly includeDirs: string[]) {}

  scan(): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(entry.parentPath, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.proto')) {
          results.push(full);
        }
      }
    };
    for (const dir of this.includeDirs) walk(path.resolve(dir));
    return results.sort();
  }

  load(): ProtoSchema {
    if (!this.cached) {
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
  }

  private buildSchema(): ProtoSchema {
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) => this.resolveImport(target);
    const files = this.scan();
    for (const file of files) root.loadSync(file, { keepCase: true });
    root.resolveAll();

    const declarations = new Map<string, string>();
    walkReflection(root, (obj) => {
      if (
        obj instanceof protobuf.Type ||
        obj instanceof protobuf.Enum ||
        obj instanceof protobuf.Service
      ) {
        // protobufjs 运行时会在 parse 的对象上挂 filename,但 d.ts 未声明 —— 用 in 窄化,不做内联断言
        const filename = 'filename' in obj && typeof obj.filename === 'string' ? obj.filename : '';
        declarations.set(obj.fullName.slice(1), filename);
      }
    });
    return { root, declarations, files };
  }

  /** protoc 语义:import 只相对 includeDirs 解析(绝对路径原样放行)。 */
  private resolveImport(target: string): string {
    if (path.isAbsolute(target) && fs.existsSync(target)) return path.normalize(target);
    for (const dir of this.includeDirs) {
      const candidate = path.join(path.resolve(dir), target);
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`import not found: ${target}`);
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
