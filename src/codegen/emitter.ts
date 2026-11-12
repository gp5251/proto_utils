import path from 'node:path';
import protobuf from 'protobufjs';
import type { ProtoSchema } from '../runtime/protoFrontend';
import { walkReflection } from '../runtime/protoFrontend';

export interface CodeGenConfig {
  enumStyle: 'enum' | 'union';
  optionalMessageFields: boolean;
  optionalScalarFields: boolean;
  fieldNaming: 'camelCase' | 'preserve';
  oneofStyle: 'optional' | 'union';
  /** 跨文件 import 路径后缀:'ts' 带 .ts(默认,0.3.12 起),'none' 不带。 */
  importExtension: 'ts' | 'none';
  /** 64 位整数标量(int64/uint64/sint64/fixed64/sfixed64)的 TS 映射,默认 'number'。 */
  int64Style: 'number' | 'bigint' | 'string';
}

export const DEFAULT_CONFIG: CodeGenConfig = {
  enumStyle: 'enum',
  optionalMessageFields: true,
  optionalScalarFields: false,
  fieldNaming: 'camelCase',
  oneofStyle: 'optional',
  importExtension: 'ts',
  int64Style: 'number',
};

/** 除 64 位整数外的标量静态映射;64 位整数走 int64Style 旋钮。 */
const SCALAR_MAP: Record<string, string> = {
  double: 'number', float: 'number',
  int32: 'number', uint32: 'number',
  sint32: 'number', fixed32: 'number', sfixed32: 'number',
  bool: 'boolean', string: 'string', bytes: 'Uint8Array',
};

/** 64 位整数标量集合,TS 映射由 config.int64Style 决定。 */
const INT64_TYPES: Record<string, true> = {
  int64: true, uint64: true, sint64: true, fixed64: true, sfixed64: true,
};

/**
 * 0.3.89:不能直接作 TS 类型名的保留字(TS2427/TS2300),以及产物自身依赖、
 * 一旦被同名 interface 遮蔽就会报错的内建工具类型(TS2315 等)。命中者加 `_` 后缀。
 * 名单经 tsc 逐名探针测定(含 bigint 等类型关键字);上下文关键字(as/type/from 等)合法,不在列。
 * 枚举成员名与接口属性名用保留字是合法的,无需消毒。
 */
const RESERVED_TYPE_NAMES = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements',
  'interface', 'package', 'private', 'protected', 'public', 'await',
  'any', 'boolean', 'number', 'string', 'symbol', 'object', 'never',
  'unknown', 'undefined', 'bigint',
]);
const SHADOWED_BUILTINS = new Set(['Record', 'Promise', 'AsyncIterable', 'Uint8Array']);

function sanitizeTypeName(name: string): string {
  return RESERVED_TYPE_NAMES.has(name) || SHADOWED_BUILTINS.has(name) ? `${name}_` : name;
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * 0.3.89:数字后缀消歧的单一实现:candidate 已被占用时按 stem2、stem3… 顺延,
 * 结果记入 taken 并返回。stem 缺省即 candidate(导出名/字段名/import 别名);
 * WKT 让位时传 GoogleProtobuf 前缀词干,保证顺延名与首选名同形。
 */
function uniqueName(candidate: string, taken: Set<string>, stem: string = candidate): string {
  let name = candidate;
  for (let i = 2; taken.has(name); i++) name = `${stem}${i}`;
  taken.add(name);
  return name;
}

/**
 * Resolve a type name to the proto file path it's defined in (for import generation).
 * Return null if the type is local (same file) or scalar.
 * 入参为解析后的全限定名(无前导点);类型无法解析时退化为源码中书写的名字。
 */
export type TypeResolver = (typeName: string) => string | null;

/**
 * 生成 filePath 声明的 message/enum TS 类型与 service 客户端调用接口(0.3.8 起 service 纳入输出契约)。
 * 只输出归属 filePath 的类型(归属以 declarations 为准);跨文件类型经 resolve 生成 import。
 * 0.3.9:跨模块同名 import(或与本地类型同名)按路径段生成确定性别名,消除 TS2300。
 * 0.3.89:导出名统一预分配——嵌套平铺撞名取父链限定名、保留字/内建遮蔽加 `_`、
 * camelCase 折叠撞名回退书写名;内建 WKT 按需生成自包含本地声明;空 enum union 产 never。
 */
export function emit(schema: ProtoSchema, filePath: string, config: CodeGenConfig, resolve?: TypeResolver): string {
  const defs = topLevelDefs(schema, filePath);
  // 本文件全部导出名(顶层 + 嵌套平铺 + service Client)的确定性预分配
  const localNames = assignExportNames(schema, filePath);
  const localExportNames = new Set(localNames.values());

  // 目标文件导出名查询(按文件缓存):跨文件 import 的绑定名必须等于目标文件的实际导出名,
  // 否则目标侧嵌套改名后这边仍按书写基名 import,产物悬空(TS2305)
  const targetNamesCache = new Map<string, Map<string, string>>();
  const exportNameOf = (fqn: string): string | undefined => {
    const file = schema.declarations.get(fqn);
    if (!file) return undefined;
    if (sameFile(file, filePath)) return localNames.get(fqn);
    let names = targetNamesCache.get(file);
    if (!names) targetNamesCache.set(file, (names = assignExportNames(schema, file)));
    return names.get(fqn);
  };
  const bindingOf = (fqn: string): string => exportNameOf(fqn) ?? sanitizeTypeName(baseName(fqn));

  const { aliases, importBindings } = buildImportAliases(defs, resolve, localExportNames, bindingOf);
  const imports = new Map<string, Map<string, string>>(); // protoPath → (绑定名 → 可用名)

  // 0.3.89:随包内建的 google.protobuf WKT(declarations 值为 '')没有对应产物文件,
  // 引用它们不能走跨文件 import——按需生成自包含本地声明(含 Struct/Value 递归闭包)。
  // 与本地导出或 import 绑定同名时取 GoogleProtobuf 前缀,再撞加数字后缀。
  const wktNames = new Map<string, string>(); // fqn → 本地名
  const wktQueue: string[] = [];
  // 别名显示名也是本文件的占用名:WKT 让位时须一并避开,否则与 import 别名互撞(TS2300)
  const wktTaken = new Set<string>([...localExportNames, ...importBindings, ...aliases.values()]);
  const isBundledWkt = (fqn: string): boolean =>
    fqn.startsWith('google.protobuf.') && schema.declarations.get(fqn) === '';
  const useWkt = (fqn: string): string => {
    const existing = wktNames.get(fqn);
    if (existing) return existing;
    const base = sanitizeTypeName(baseName(fqn));
    const prefixed = `GoogleProtobuf${base}`;
    const candidate = uniqueName(wktTaken.has(base) ? prefixed : base, wktTaken, prefixed);
    wktNames.set(fqn, candidate);
    wktQueue.push(fqn);
    return candidate;
  };

  /** 类型引用 → 本文件可用名:跨文件记录 import(绑定名=目标导出名),WKT 走本地闭包,本地查预分配名。 */
  const use: TypeUse = (asWritten, resolvedFqn) => {
    const fqn = resolvedFqn ?? asWritten;
    const protoPath = resolve?.(fqn) ?? null;
    if (!protoPath) {
      if (resolvedFqn && isBundledWkt(resolvedFqn)) return useWkt(resolvedFqn);
      return (resolvedFqn ? localNames.get(resolvedFqn) : undefined) ?? sanitizeTypeName(baseName(asWritten));
    }
    const binding = bindingOf(fqn);
    const display = aliases.get(`${protoPath}\0${binding}`) ?? binding;
    let byBinding = imports.get(protoPath);
    if (!byBinding) imports.set(protoPath, (byBinding = new Map()));
    byBinding.set(binding, display);
    return display;
  };

  const lines: string[] = [];
  lines.push('// Generated by proto-utils. Do not edit.');
  lines.push('');

  const ctx: EmitContext = { config, use, lines, names: localNames };
  for (const def of defs) emitDef(def, ctx);
  // WKT 闭包:声明体内的字段引用经 use 继续入队,直到不再引入新类型
  const wktCtx: EmitContext = { ...ctx, names: wktNames };
  while (wktQueue.length > 0) {
    const obj = schema.root.lookup(wktQueue.shift()!);
    if (obj) emitDef(obj, wktCtx);
  }

  // Build import statements
  const importLines: string[] = [];
  if (imports.size > 0) {
    const ext = config.importExtension === 'ts' ? '.ts' : '';
    for (const [protoPath, byBinding] of imports) {
      // resolve 返回已带 './'/'../' 前缀的相对路径时直接用,裸路径补 './'(0.3.10 起不再产出 './../x' 双前缀)
      const spec = protoPath.replace(/\.proto$/, '');
      const fromPath = spec.startsWith('.') ? spec : `./${spec}`;
      const names = [...byBinding.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([binding, display]) => (display === binding ? binding : `${binding} as ${display}`));
      importLines.push(`import type { ${names.join(', ')} } from '${fromPath}${ext}';`);
    }
    importLines.push('');
  }

  // Combine: header + imports + body
  const header = lines.slice(0, 2);
  const body = lines.slice(2);
  return [...header, ...importLines, ...body].join('\n').trimEnd() + '\n';
}

/** 类型引用 → 本文件可用名(基名或确定性别名),副作用是记录跨文件 import。 */
type TypeUse = (asWritten: string, resolvedFqn: string | undefined) => string;

/**
 * 0.3.89:emit 过程的共享上下文——配置、类型引用解析、输出行缓冲与导出名表成组传递,
 * 取代原先在各 emit 函数间穿行的长参数列。names 为当前阶段的导出名表:
 * 主输出用 localNames,WKT 闭包用 wktNames,其余成员两阶段共享。
 */
interface EmitContext {
  config: CodeGenConfig;
  use: TypeUse;
  lines: string[];
  names: ReadonlyMap<string, string>;
}

/**
 * 0.3.89:为 filePath 的全部导出(顶层类型、嵌套平铺类型、service `<Name>Client`)预分配唯一名字。
 * 规则:保留字/内建遮蔽先加 `_`;顶层优先占位;嵌套类型基名被多个导出共享时取
 * 父链 PascalCase 限定名(Foo.Request → FooRequest);仍撞名按声明顺序加数字后缀。
 * 遍历顺序与 emitMessage 的输出顺序一致(嵌套 enum → 嵌套 message 递归 → 自身),保证确定性。
 */
function assignExportNames(schema: ProtoSchema, filePath: string): Map<string, string> {
  interface Entry {
    fqn: string;
    rawBase: string;
    base: string;
    chain: string[];
    top: boolean;
  }
  const entries: Entry[] = [];
  const push = (obj: protobuf.Type | protobuf.Enum, chain: string[], top: boolean): void => {
    entries.push({
      fqn: obj.fullName.replace(/^\./, ''),
      rawBase: obj.name,
      base: sanitizeTypeName(obj.name),
      chain,
      top,
    });
  };
  const walkType = (t: protobuf.Type, chain: string[]): void => {
    for (const n of t.nestedArray) {
      if (n instanceof protobuf.Enum) push(n, [...chain, t.name], false);
    }
    for (const n of t.nestedArray) {
      if (n instanceof protobuf.Type) walkType(n, [...chain, t.name]);
    }
    push(t, chain, chain.length === 0);
  };
  for (const def of topLevelDefs(schema, filePath)) {
    if (def instanceof protobuf.Type) walkType(def, []);
    else if (def instanceof protobuf.Enum) push(def, [], true);
    else {
      const clientName = `${def.name}Client`;
      entries.push({
        fqn: def.fullName.replace(/^\./, ''),
        rawBase: clientName,
        base: sanitizeTypeName(clientName),
        chain: [],
        top: true,
      });
    }
  }

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.base, (counts.get(e.base) ?? 0) + 1);
  const taken = new Set<string>();
  const result = new Map<string, string>();
  // 第一轮:顶层类型优先保留原名
  for (const e of entries) {
    if (e.top) result.set(e.fqn, uniqueName(e.base, taken));
  }
  // 第二轮:嵌套类型——基名有竞争才取限定名,避免无谓改名
  for (const e of entries) {
    if (e.top) continue;
    const candidate =
      (counts.get(e.base) ?? 0) > 1
        ? sanitizeTypeName(e.chain.map(capitalizeFirst).join('') + e.rawBase)
        : e.base;
    result.set(e.fqn, uniqueName(candidate, taken));
  }
  return result;
}

/**
 * 0.3.89:为 message 字段预分配唯一属性名。camelCase 折叠撞名(foo_bar 与 fooBar)时,
 * 书写名恰为首选名的字段保留首选名,其余回退原始书写名;极端仍撞名按声明顺序加数字后缀。
 * oneof 字段与常规字段共用同一张表,union 变体的 `?: never` 排除名也走它。
 */
function assignFieldNames(msg: protobuf.Type, config: CodeGenConfig): Map<protobuf.Field, string> {
  const fields = msg.fieldsArray;
  const preferredOf = (f: protobuf.Field): string => fieldName(f.name, config);
  const counts = new Map<string, number>();
  for (const f of fields) {
    const p = preferredOf(f);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const candidate = new Map<protobuf.Field, string>();
  const taken = new Set<string>();
  for (const f of fields) {
    const p = preferredOf(f);
    if ((counts.get(p) ?? 0) < 2 || f.name === p) {
      candidate.set(f, p);
      taken.add(p);
    }
  }
  for (const f of fields) {
    if (!candidate.has(f)) candidate.set(f, taken.has(f.name) ? preferredOf(f) : f.name);
  }
  const result = new Map<protobuf.Field, string>();
  const used = new Set<string>();
  for (const f of fields) {
    result.set(f, uniqueName(candidate.get(f)!, used));
  }
  return result;
}

/**
 * 预扫描 defs 的全部类型引用,为跨模块同名(或与本地导出同名)的 import 生成确定性别名。
 * 键为 `${protoPath}\0${绑定名}`;别名 = 路径段 PascalCase 拼接 + 绑定名(如 ProjectGlobalV1ResponseStatus)。
 * 0.3.89:绑定名取目标文件实际导出名;别名还须避开其他 import 绑定名与彼此,撞名加数字后缀
 * (foo/bar.proto 与 fooBar.proto 同形别名 FooBarStatus 不再互撞)。
 */
function buildImportAliases(
  defs: Array<protobuf.Type | protobuf.Enum | protobuf.Service>,
  resolve: TypeResolver | undefined,
  localExportNames: ReadonlySet<string>,
  bindingOf: (fqn: string) => string,
): { aliases: Map<string, string>; importBindings: Set<string> } {
  const aliases = new Map<string, string>();
  const pathsByBinding = new Map<string, Set<string>>();
  if (resolve) {
    const record = (asWritten: string, resolvedFqn: string | undefined): void => {
      if (isScalar(asWritten)) return;
      const fqn = resolvedFqn ?? asWritten;
      const protoPath = resolve(fqn);
      if (!protoPath) return;
      const binding = bindingOf(fqn);
      let paths = pathsByBinding.get(binding);
      if (!paths) pathsByBinding.set(binding, (paths = new Set()));
      paths.add(protoPath);
    };
    const walkType = (t: protobuf.Type): void => {
      for (const f of t.fieldsArray) record(f.type, fqnOf(f.resolvedType));
      for (const n of t.nestedArray) {
        if (n instanceof protobuf.Type) walkType(n);
      }
    };
    for (const def of defs) {
      if (def instanceof protobuf.Type) walkType(def);
      else if (def instanceof protobuf.Service) {
        for (const m of def.methodsArray) {
          record(m.requestType, fqnOf(m.resolvedRequestType));
          record(m.responseType, fqnOf(m.resolvedResponseType));
        }
      }
    }
  }

  const importBindings = new Set(pathsByBinding.keys());
  const taken = new Set<string>([...localExportNames, ...importBindings]);
  for (const binding of [...pathsByBinding.keys()].sort()) {
    const paths = pathsByBinding.get(binding)!;
    if (paths.size < 2 && !localExportNames.has(binding)) continue;
    for (const protoPath of [...paths].sort()) {
      const segments = protoPath
        .replace(/\.proto$/, '')
        .split('/')
        .filter((s) => s && s !== '.' && s !== '..')
        .map(capitalizeFirst);
      const stem = `${segments.join('')}${binding}`;
      const alias = uniqueName(stem, taken);
      aliases.set(`${protoPath}\0${binding}`, alias);
    }
  }
  return { aliases, importBindings };
}

// ─── Path factories(输出路径与 import 相对路径数学的单一来源)───

export interface OutputPathOptions {
  workspaceRoot: string;
  outputDir: string;
  /** file:相对全部 proto 的公共目录映射目录结构(默认);package:按 package 语句映射目录。 */
  pathMapping: 'package' | 'file';
}

/** proto 文件绝对路径 → 生成的 .ts 绝对路径。 */
export function createOutputPathResolver(schema: ProtoSchema, options: OutputPathOptions): (protoFile: string) => string {
  const relPathOf = createRelPathResolver(schema, options);
  return (protoFile) => path.join(options.workspaceRoot, options.outputDir, relPathOf(protoFile));
}

/** 基于 declarations 归属构造 TypeResolver:同文件/未知类型返回 null,否则返回相对 import 路径。 */
export function createTypeResolver(schema: ProtoSchema, fromFile: string, options: OutputPathOptions): TypeResolver {
  const relPathOf = createRelPathResolver(schema, options);
  return (typeName) => {
    const target = schema.declarations.get(typeName);
    if (!target || sameFile(target, fromFile)) return null;

    // Relative path from current output to target output
    const fromDir = path.dirname(relPathOf(fromFile));
    let rel = path.relative(fromDir, relPathOf(target)).replace(/\\/g, '/').replace(/\.ts$/, '');
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
  };
}

/** schema 是否包含某个 proto 文件(命令层用来拒绝 includeDirs 之外的文件)。 */
export function schemaHasFile(schema: ProtoSchema, filePath: string): boolean {
  return schema.files.some((f) => sameFile(f, filePath));
}

/** 输出撞名详情:first/second 为报错点名的两个 proto 文件,outPath 为撞到的输出绝对路径。 */
export interface OutputConflict {
  first: string;
  second: string;
  outPath: string;
}

/**
 * 0.3.89:输出撞名检测的单一实现(单文件与批量命令共用)。
 * 给定 targetFile 时找「另一个」会写到同一输出的文件(first=targetFile);
 * 缺省时按 schema.files 声明顺序返回第一对撞名文件(first=先声明者)。
 * 只有含可生成类型的文件参与比较;输出路径比较在 win32 不分大小写。无冲突返回 null。
 * 命令层据此拒绝落盘——package 映射下同 package 的多个 proto 会写到同一个 .ts。
 */
export function findOutputConflict(
  schema: ProtoSchema,
  options: OutputPathOptions,
  targetFile?: string,
): OutputConflict | null {
  const outPathOf = createOutputPathResolver(schema, options);
  if (targetFile !== undefined) {
    const outPath = outPathOf(targetFile);
    const target = normalizeFile(outPath);
    for (const other of schema.files) {
      if (sameFile(other, targetFile) || !hasEmittableTypes(schema, other)) continue;
      if (normalizeFile(outPathOf(other)) === target) {
        return { first: targetFile, second: other, outPath };
      }
    }
    return null;
  }
  const ownerByOut = new Map<string, string>();
  for (const file of schema.files) {
    if (!hasEmittableTypes(schema, file)) continue;
    const outPath = outPathOf(file);
    const key = normalizeFile(outPath);
    const owner = ownerByOut.get(key);
    if (owner) return { first: owner, second: file, outPath };
    ownerByOut.set(key, file);
  }
  return null;
}

/** proto 文件绝对路径 → 相对 outputDir 的输出 .ts 相对路径(package / file 映射)。 */
function createRelPathResolver(schema: ProtoSchema, options: OutputPathOptions): (protoFile: string) => string {
  const packages = options.pathMapping === 'package' ? packageByFile(schema) : null;
  const relRoot = options.pathMapping === 'file' ? commonProtoRoot(schema.files) : null;
  return (protoFile) => {
    if (packages) {
      const pkg = packages.get(normalizeFile(protoFile));
      if (pkg) {
        // package my.service → my/service.ts
        return pkg.replace(/\./g, '/') + '.ts';
      }
    }
    // file:相对全部 proto 的最长公共目录映射——平级 proto 平铺,子目录 proto 保留子结构(common/a/b.proto → a/b.ts)
    return path.relative(relRoot ?? options.workspaceRoot, protoFile).replace(/\.proto$/, '.ts');
  };
}

/** 全部 proto 文件的最长公共目录(file 映射的相对根;win32 比较不分大小写)。 */
function commonProtoRoot(files: string[]): string {
  if (files.length === 0) return '';
  const splitDir = (p: string): string[] => {
    const parts = path.dirname(path.normalize(p)).split(path.sep);
    return process.platform === 'win32' ? parts.map((s) => s.toLowerCase()) : parts;
  };
  const prefix = splitDir(files[0]);
  for (const f of files.slice(1)) {
    const parts = splitDir(f);
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
    prefix.length = i;
  }
  return prefix.join(path.sep);
}

/** 从反射树推导每个 proto 文件的 package(文件内全部顶层类型共享同一条 package 语句)。 */
function packageByFile(schema: ProtoSchema): Map<string, string> {
  const result = new Map<string, string>();
  walkReflection(schema.root, (obj) => {
    if (obj instanceof protobuf.Type || obj instanceof protobuf.Enum || obj instanceof protobuf.Service) {
      const file = declaringFile(schema, obj);
      if (file && !result.has(normalizeFile(file))) {
        let outer: protobuf.ReflectionObject = obj;
        while (outer.parent instanceof protobuf.Type) outer = outer.parent;
        const pkg = outer.parent ? outer.parent.fullName.replace(/^\./, '') : '';
        result.set(normalizeFile(file), pkg);
      }
    }
  });
  return result;
}

// ─── Reflection helpers ──────────────────────────────────────

/** filePath 声明的顶层 message/enum/service(message 嵌套类型随父输出),按声明顺序。 */
function topLevelDefs(schema: ProtoSchema, filePath: string): Array<protobuf.Type | protobuf.Enum | protobuf.Service> {
  const defs: Array<protobuf.Type | protobuf.Enum | protobuf.Service> = [];
  walkReflection(schema.root, (obj, parent) => {
    if (
      !(parent instanceof protobuf.Type) &&
      (obj instanceof protobuf.Type || obj instanceof protobuf.Enum || obj instanceof protobuf.Service)
    ) {
      const file = declaringFile(schema, obj);
      if (file && sameFile(file, filePath)) defs.push(obj);
    }
  });
  return defs;
}

/** filePath 是否声明了可生成的顶层 message/enum/service;false(纯 import 聚合文件)时产物只有头部,命令层不落盘。 */
export function hasEmittableTypes(schema: ProtoSchema, filePath: string): boolean {
  return topLevelDefs(schema, filePath).length > 0;
}

function declaringFile(schema: ProtoSchema, obj: protobuf.ReflectionObject): string | undefined {
  return schema.declarations.get(obj.fullName.replace(/^\./, ''));
}

/** 反射对象 → 无前导点全限定名;未解析(null/undefined)返回 undefined。 */
function fqnOf(obj: protobuf.ReflectionObject | null | undefined): string | undefined {
  return obj ? obj.fullName.replace(/^\./, '') : undefined;
}

function normalizeFile(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function sameFile(a: string, b: string): boolean {
  return normalizeFile(a) === normalizeFile(b);
}

/** proto3 optional 在 protobufjs 8.x 里表现为合成 oneof `_<field>`(field.proto3Optional 不存在)。 */
function isProto3Optional(field: protobuf.Field): boolean {
  const partOf = field.partOf;
  return partOf != null && partOf.fieldsArray.length === 1 && partOf.name === `_${field.name}`;
}

function isSyntheticOptionalOneof(oneof: protobuf.OneOf): boolean {
  return oneof.fieldsArray.length === 1 && oneof.name === `_${oneof.fieldsArray[0].name}`;
}

// ─── Helpers ─────────────────────────────────────────────────

function toCamelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

function fieldName(name: string, config: CodeGenConfig): string {
  return config.fieldNaming === 'camelCase' ? toCamelCase(name) : name;
}

function isScalar(typeName: string): boolean {
  // Object.hasOwn:`in`/真值判断会把原型链上的名字(如合法的 `message toString {}`)误判成标量
  return Object.hasOwn(SCALAR_MAP, typeName) || Object.hasOwn(INT64_TYPES, typeName);
}

function baseName(typeName: string): string {
  return typeName.includes('.') ? typeName.split('.').pop()! : typeName;
}

/** 标量 → TS 类型:64 位整数按 config.int64Style,其余查静态表。 */
function scalarTypeTs(typeName: string, config: CodeGenConfig): string {
  if (Object.hasOwn(INT64_TYPES, typeName)) return config.int64Style;
  return SCALAR_MAP[typeName];
}

/** 字段类型 → TS 类型文本:标量查表,跨文件类型经 ctx.use 记录 import 并取可用名。 */
function fieldTypeTs(typeName: string, resolvedFqn: string | undefined, ctx: EmitContext): string {
  if (isScalar(typeName)) return scalarTypeTs(typeName, ctx.config);
  return ctx.use(typeName, resolvedFqn);
}

// ─── Emitters ────────────────────────────────────────────────

/** 0.3.89:按反射类别输出单个定义(message/enum/service);主输出与 WKT 闭包共用的单一 instanceof 分派。 */
function emitDef(def: protobuf.ReflectionObject, ctx: EmitContext): void {
  if (def instanceof protobuf.Service) emitService(def, ctx);
  else if (def instanceof protobuf.Type) emitMessage(def, ctx);
  else if (def instanceof protobuf.Enum) emitEnum(def, ctx);
}

/** message 的输出计划:导出名、字段名表与常规/oneof 字段分组(planMessage 推导,两个输出分支消费)。 */
interface MessagePlan {
  exportName: string;
  fieldNames: ReadonlyMap<protobuf.Field, string>;
  regularFields: protobuf.Field[];
  oneofs: protobuf.OneOf[];
}

function planMessage(msg: protobuf.Type, ctx: EmitContext): MessagePlan {
  return {
    exportName: ctx.names.get(msg.fullName.replace(/^\./, '')) ?? msg.name,
    fieldNames: assignFieldNames(msg, ctx.config),
    regularFields: msg.fieldsArray.filter((f) => !f.partOf || isProto3Optional(f)),
    oneofs: msg.oneofsArray.filter((o) => !isSyntheticOptionalOneof(o)),
  };
}

function emitMessage(msg: protobuf.Type, ctx: EmitContext): void {
  // Nested enums first
  for (const nested of msg.nestedArray) {
    if (nested instanceof protobuf.Enum) {
      emitEnum(nested, ctx);
      ctx.lines.push('');
    }
  }
  // Nested messages
  for (const nested of msg.nestedArray) {
    if (nested instanceof protobuf.Type) {
      emitMessage(nested, ctx);
      ctx.lines.push('');
    }
  }

  const plan = planMessage(msg, ctx);
  // Handle oneof as union type
  if (ctx.config.oneofStyle === 'union' && plan.oneofs.length > 0) {
    emitUnionOneofMessage(plan, ctx);
    return;
  }

  ctx.lines.push(`export interface ${plan.exportName} {`);

  for (const field of plan.regularFields) {
    ctx.lines.push(`  ${renderField(field, plan.fieldNames.get(field)!, ctx)};`);
  }

  // Oneof fields as optional
  for (const oneof of plan.oneofs) {
    for (const field of oneof.fieldsArray) {
      const name = plan.fieldNames.get(field)!;
      const type = fieldTypeTs(field.type, fqnOf(field.resolvedType), ctx);
      ctx.lines.push(`  ${name}?: ${type};`);
    }
  }

  ctx.lines.push('}');
  ctx.lines.push('');
}

function emitUnionOneofMessage(plan: MessagePlan, ctx: EmitContext): void {
  const { exportName, fieldNames, regularFields, oneofs } = plan;
  // Regular fields as a base interface
  const rendered = regularFields.map((f) => renderField(f, fieldNames.get(f)!, ctx));

  // 每个 oneof 产出一组互斥变体(选中字段必填、同组其余 ?: never);
  // 多个 oneof 以交集组合:(A|B) & (C|D) 语义上即「每组各选其一」的笛卡尔积,
  // 且输出规模随 oneof 数线性增长。
  // 0.3.70 修:此前按 oneof 逐条 emit `export type X`,一个 message 带两个以上
  // oneof 会产出同名重复声明(TS2300),且每条声明都丢了其他 oneof 的变体。
  const unions = oneofs.map((oneof) => {
    const variants = oneof.fieldsArray.map((field) => {
      const name = fieldNames.get(field)!;
      const type = fieldTypeTs(field.type, fqnOf(field.resolvedType), ctx);
      // This variant has this field set, others in the oneof are never
      const othersNever = oneof.fieldsArray
        .filter((f) => f !== field)
        .map((f) => `${fieldNames.get(f)!}?: never`)
        .join('; ');
      return `{ ${name}: ${type}; ${othersNever} }`;
    });
    return `(\n  | ${variants.join('\n  | ')}\n)`;
  });

  // 常规字段作交集基:必须是对象类型字面量 { f: T; ... }。
  // (0.3.70 修:此前写成 `(${rendered.join(' & ')})` —— 把 `id: string` 这类
  // 对象成员裸放进括号,TS 会按函数类型解析报 TS1005「'=>' expected」,
  // 即「有常规字段 + oneof + union 风格」的产物从来编译不过。)
  const base = rendered.length > 0 ? `{ ${rendered.join('; ')} } & ` : '';
  ctx.lines.push(`export type ${exportName} = ${base}${unions.join(' & ')};`);
  ctx.lines.push('');
}

function renderField(field: protobuf.Field, name: string, ctx: EmitContext): string {
  const { config } = ctx;
  // 跨文件归属以解析后的全限定名为准;解析不到(如未 resolveAll)退化为书写名
  const fqn = fqnOf(field.resolvedType);

  if (field.map) {
    // protobufjs 运行时 map 字段带 keyType,但 v8 d.ts 未在 Field 上声明 —— 用 in 窄化,不做内联断言
    const keyType = 'keyType' in field && typeof field.keyType === 'string' ? field.keyType : field.type;
    let key = isScalar(keyType) ? scalarTypeTs(keyType, config) : keyType;
    // 0.3.89:Record 键必须是 PropertyKey(string|number|symbol)——bigint/boolean 等一律回退 string
    if (key !== 'string' && key !== 'number' && key !== 'symbol') key = 'string';
    const val = fieldTypeTs(field.type, fqn, ctx);
    return `${name}: Record<${key}, ${val}>`;
  }

  if (field.repeated) {
    return `${name}: ${fieldTypeTs(field.type, fqn, ctx)}[]`;
  }

  // proto3 optional = 显式 presence,恒渲染为 `?`,不受两个 optional 旋钮影响
  const scalar = isScalar(field.type);
  const optional = isProto3Optional(field)
    ? true
    : scalar
      ? config.optionalScalarFields
      : config.optionalMessageFields;
  return `${name}${optional ? '?' : ''}: ${fieldTypeTs(field.type, fqn, ctx)}`;
}

function emitEnum(e: protobuf.Enum, ctx: EmitContext): void {
  const exportName = ctx.names.get(e.fullName.replace(/^\./, '')) ?? e.name;
  const values = Object.entries(e.values);
  if (ctx.config.enumStyle === 'union') {
    // 0.3.89:空 enum 的 union 是空联合,必须写 never(此前产出 `export type E = ;` 语法错误)
    const members = values.map(([name]) => `'${name}'`).join(' | ') || 'never';
    ctx.lines.push(`export type ${exportName} = ${members};`);
  } else {
    ctx.lines.push(`export enum ${exportName} {`);
    for (const [name, id] of values) {
      ctx.lines.push(`  ${name} = ${id},`);
    }
    ctx.lines.push('}');
  }
  ctx.lines.push('');
}

/** service → 客户端调用接口 `<Name>Client`:unary 返回 Promise,流式方向用 AsyncIterable 表达(stdlib 无依赖)。 */
function emitService(svc: protobuf.Service, ctx: EmitContext): void {
  const exportName = ctx.names.get(svc.fullName.replace(/^\./, '')) ?? `${svc.name}Client`;
  ctx.lines.push(`export interface ${exportName} {`);
  for (const method of svc.methodsArray) {
    const req = fieldTypeTs(method.requestType, fqnOf(method.resolvedRequestType), ctx);
    const res = fieldTypeTs(method.responseType, fqnOf(method.resolvedResponseType), ctx);
    const param = method.requestStream ? `AsyncIterable<${req}>` : req;
    const ret = method.responseStream ? `AsyncIterable<${res}>` : `Promise<${res}>`;
    ctx.lines.push(`  ${method.name}(request: ${param}): ${ret};`);
  }
  ctx.lines.push('}');
  ctx.lines.push('');
}
