import path from 'node:path';
import protobuf from 'protobufjs';

import { bundledGoogleJson, filenameOf, walkReflection } from '../runtime/protoFrontend';
import type { ProtoSchema } from '../runtime/protoFrontend';
import type { Range, TypeRef } from '../index/symbols';

/**
 * 「类型存在但未 import」检测的纯函数核心(0.3.43):零 vscode 依赖,全部可 node:test 直测。
 *
 * 背景:ProtoFrontend 把 includeDirs 下所有 .proto 当 root 全量加载,工作区内存在的
 * 类型总能 resolve 成功;但 runner 平面(@grpc/proto-loader)与 protoc 按文件 import
 * 闭包加载,漏 import 会在运行时才爆 "no such type"。本模块在 load 成功结果上提前
 * 暴露这类引用:语义判定只消费 ProtoFrontend 的产物(ADR-0002),import 字符串与
 * typeRefs 位置取自零语义扫描器(ADR-0003),不自行做任何名解析。
 *
 * 已知限制:extend 块(proto2 扩展 / proto3 自定义 option)内的类型引用不检测——
 * 扩展字段不在 Type.fieldsArray,scanner 也不记 extend 块的 typeRefs,两层都是盲区。
 */

/** import 解析器:与 ProtoFrontend.resolveImport 同语义(includeDirs 优先、origin 目录回退),找不到返回 null。 */
export type ImportResolver = (target: string, origin?: string) => string | null;

/** 诊断对象上挂载的 Quick Fix 数据;provider 用 'missingImportFix' in diag 窄化读取。 */
export interface MissingImportFix {
  /** 待插入的 import 路径(includeDir 相对优先,正斜杠)。 */
  importPath: string;
}

/** Diagnostic.code:漏 import 诊断与 Quick Fix CodeAction 的关联键。 */
export const MISSING_IMPORT_CODE = 'missing-import';

/** 一条「未 import」违规:引用文件引用了定义文件的类型,但定义文件不在其 import 闭包内。 */
export interface MissingImportFinding {
  /** 引用方文件绝对路径。 */
  referencingFile: string;
  /** 定义方文件绝对路径。 */
  definingFile: string;
  /** 全限定类型名(无前导点)。 */
  typeFqn: string;
  /** 源码原文写法(Field.type / Method.requestType 等),供按位置精确匹配。 */
  refText: string;
}

/** 与 ProtoFrontend.scan 的 seen-key 同款归一:normalize + win32 小写。 */
export function normPath(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * import 传递闭包(含 rootFile 自身),返回归一化绝对路径集合。
 * google/protobuf/* 仅内建名跳过(bundledGoogleJson 非空)——与 loadInto 的 bundled
 * 判定同源:工作区自供的非内建 google proto 会从磁盘加载,这条边必须跟随,否则误报。
 * 解析失败的边容忍跳过——闭包是 best-effort,漏边只会少放行不会错放行。
 * visited 去环(protobufjs loadInto 同样按 key 去重容忍环);pop() 取栈顶,
 * 遍历顺序无关结果,免 shift() 的 O(n) 搬移。
 */
export function computeImportClosure(
  rootFile: string,
  importsOf: (file: string) => readonly string[],
  resolve: ImportResolver,
): Set<string> {
  const seen = new Set<string>([normPath(rootFile)]);
  const stack = [rootFile];
  while (stack.length > 0) {
    const file = stack.pop()!;
    for (const imp of importsOf(file)) {
      if (bundledGoogleJson(imp)) continue;
      const resolved = resolve(imp, file);
      if (!resolved) continue;
      const key = normPath(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(resolved);
    }
  }
  return seen;
}

/**
 * 在 load 成功的 schema 上找出全部「工作区有定义但不在 import 闭包内」的类型引用。
 * 绝不抛:调用方在 load 成功路径调用,检测 bug 不得把成功 load 变成报错。
 *
 * 锚点:resolve 成功后 Field.resolvedType / Method.resolvedRequestType 指向定义对象,
 * 定义对象与所属 Type/Service 的 filename 即定义/引用文件;google 内建经 addJSON
 * 注入无 filename,天然跳过。闭包语义对齐 runner 平面(传递可见),protoc 的
 * 「必须直接 import」规则在此不适用,不会因传递 import 误报。
 */
export function findMissingImports(
  schema: ProtoSchema,
  importsOf: (file: string) => readonly string[],
  resolve: ImportResolver,
): MissingImportFinding[] {
  const findings: MissingImportFinding[] = [];
  const seen = new Set<string>();
  const closures = new Map<string, Set<string>>();
  const closureOf = (file: string): Set<string> => {
    let c = closures.get(file);
    if (!c) {
      c = computeImportClosure(file, importsOf, resolve);
      closures.set(file, c);
    }
    return c;
  };
  const check = (resolved: protobuf.ReflectionObject | null, refText: string, refFile: string): void => {
    if (!resolved || !refFile) return;
    const defFile = filenameOf(resolved);
    if (!defFile) return;
    if (normPath(defFile) === normPath(refFile)) return;
    if (closureOf(refFile).has(normPath(defFile))) return;
    // 同写法同文件引用同一缺失类型只记一条;定位阶段会把该写法的所有出现处都飘红
    const key = `${normPath(refFile)}\0${normPath(defFile)}\0${refText}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      referencingFile: refFile,
      definingFile: defFile,
      typeFqn: resolved.fullName.replace(/^\./, ''),
      refText,
    });
  };
  walkReflection(schema.root, (obj) => {
    const refFile = filenameOf(obj);
    if (obj instanceof protobuf.Type) {
      // map 字段的 key 恒为标量(MapField.type 即 value 类型),无需单独查 resolvedKeyType
      for (const field of obj.fieldsArray) check(field.resolvedType, field.type, refFile);
    } else if (obj instanceof protobuf.Service) {
      for (const method of obj.methodsArray) {
        check(method.resolvedRequestType, method.requestType, refFile);
        check(method.resolvedResponseType, method.responseType, refFile);
      }
    }
  });
  return findings;
}

/**
 * 在引用文件的 typeRefs 里定位 refText 的出现位置。
 * Field/Method 无源码 range,只能按名反查:两侧去前导点后精确匹配优先
 * (protobufjs 保留原文写法,几乎必中);落空退短名匹配(与 reportUnresolvedTypeRefs
 * 的反查同级);全落空返回空——宁缺毋滥,不产生定位不了的诊断。
 */
export function locateTypeRefs(typeRefs: TypeRef[], refText: string): Range[] {
  const strip = (s: string): string => s.replace(/^\./, '');
  const target = strip(refText);
  let hits = typeRefs.filter((r) => strip(r.name) === target);
  if (hits.length === 0) {
    const short = target.split('.').pop()!;
    hits = typeRefs.filter((r) => strip(r.name).split('.').pop() === short);
  }
  return hits.map((r) => r.range);
}

/** 计算 quick fix 要插入的 import 字符串:includeDir 相对(protoc -I 语义)优先,统一正斜杠;都不含 definingFile 时退回相对引用文件目录。 */
export function computeImportPath(
  definingFile: string,
  referencingFile: string,
  includeDirs: string[],
): string {
  for (const dir of includeDirs) {
    const rel = path.relative(path.resolve(dir), definingFile);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  }
  return path.relative(path.dirname(referencingFile), definingFile).split(path.sep).join('/');
}

/** 注释抹空白(保留换行,行号不漂移):// 到行尾、跨行块注释。字符串字面量内的 // 或 /* 不识别——proto header 区罕见,可接受。 */
function blankComments(text: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'lineComment' | 'blockComment' = 'code';
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (state === 'code' && c === '/' && next === '/') {
      state = 'lineComment';
      i += 2;
    } else if (state === 'code' && c === '/' && next === '*') {
      state = 'blockComment';
      i += 2;
    } else if (state === 'lineComment') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
    } else if (state === 'blockComment') {
      if (c === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else {
        if (c === '\n') out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * import 语句的插入点(在该行之前插入;可能等于行数 = 文件末行之后,由调用方钳制):
 * 最后一个 import 行之后 → package 行之后 → syntax 行之后 → 文件头。
 * 注释先行抹白,块注释内部的 import 字样行不会误判为锚点。
 */
export function findImportInsertionLine(text: string): number {
  const lines = blankComments(text).split('\n');
  let lastImport = -1;
  let packageLine = -1;
  let syntaxLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*import\s+"/.test(line)) lastImport = i;
    else if (packageLine === -1 && /^\s*package\s+/.test(line)) packageLine = i;
    else if (syntaxLine === -1 && /^\s*syntax\s*=/.test(line)) syntaxLine = i;
  }
  if (lastImport !== -1) return lastImport + 1;
  if (packageLine !== -1) return packageLine + 1;
  if (syntaxLine !== -1) return syntaxLine + 1;
  return 0;
}
