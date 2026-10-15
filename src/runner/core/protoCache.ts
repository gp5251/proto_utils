import path from 'path';
import fs from 'fs';
import * as protoLoader from '@grpc/proto-loader';
import { bundledGoogleJson, createImportResolver } from '../../runtime/protoFrontend';
import { readProtoFile } from '../../runtime/protoEncoding';

interface CacheEntry {
  def: protoLoader.PackageDefinition;
  /**
   * mtimeMs:size 指纹(0.3.45 仅顶层文件,0.3.77 扩到 import 闭包):命中后 stat 校验,
   * 变更自动重析,不再依赖全清缓存。只 stat 顶层时,被 import 文件的改动不会失效
   * 顶层 def——其内嵌的导入类型旧拷贝会按扫描序被 findTypeDef 先命中,工作台
   * 永远显示旧枚举/旧字段(autoshop 现场:枚举改在 communicate_global.proto,
   * 服务声明文件未动,刷新 proto 与重开面板均无效)。
   */
  stamp: string;
  /** 参与指纹的文件绝对路径(import 闭包,含自身)。 */
  closure: string[];
}

const cache = new Map<string, CacheEntry>();

/** import 语句:裸 / public / weak 三种写法;matchAll 逐调用克隆正则,递归安全。 */
const IMPORT_RE = /import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/g;

/**
 * 沿 import 边递归收集闭包。解析语义与 loadSync 的 includeDirs 同源
 * (createImportResolver:[protoDir] 优先、退回导入文件所在目录);
 * 读不到/解析不到的边跳过——loadSync 会照常抛错,由调用方 per-file 收集。
 */
function collectClosure(
  file: string,
  resolveImport: (target: string, origin?: string) => string | null,
  seen: Set<string>,
  out: string[],
): void {
  if (seen.has(file)) return;
  seen.add(file);
  let content: string;
  try {
    content = readProtoFile(file);
  } catch {
    return; // 读不到不入闭包:loadSync 自会抛错,不会缓存本条目
  }
  out.push(file);
  for (const m of content.matchAll(IMPORT_RE)) {
    const target = m[1];
    if (bundledGoogleJson(target)) continue; // google 内建类型不落盘,不入指纹
    const resolved = resolveImport(target, file);
    if (resolved) collectClosure(resolved, resolveImport, seen, out);
  }
}

/** 闭包逐文件 mtimeMs:size 拼接;任一 stat 失败返回 null(视为失配)。 */
function closureStamp(closure: string[]): string | null {
  const parts: string[] = [];
  for (const file of closure) {
    try {
      const st = fs.statSync(file);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      return null;
    }
  }
  return parts.join('|');
}

/**
 * 调用面契约(keepCase:false/longs:String/enums:Number/defaults:true/oneofs:true),
 * 逐字沿用 rpc_runner;与 emitter 平面的 ProtoFrontend(keepCase:true)互不共享。
 * longs:String(0.3.35 起,原 Number):int64/uint64 等 64 位整型以 string 往返,
 * 避免超过 2^53 被截断;请求侧 protobufjs fromObject 接受 string,无需额外转换。
 */
export function getPackageDefinition(
  protoFile: string,
  protoDir: string,
): protoLoader.PackageDefinition {
  const absPath = path.resolve(protoFile);
  // 热路径:只对已缓存的闭包清单 stat,不读文件。闭包形状(import 边)只随成员文件
  // 内容变化,而内容变化必体现为该成员 stamp 失配——故仅 stat 旧清单即可闭环判定。
  const cached = cache.get(absPath);
  if (cached) {
    const stamp = closureStamp(cached.closure);
    if (stamp !== null && stamp === cached.stamp) {
      return cached.def;
    }
  }
  // 失配/首载:重算闭包(读文件跟 import 边)再比一次——import 重排等内容等价改动免重析
  const closure: string[] = [];
  collectClosure(absPath, createImportResolver([path.resolve(protoDir)]), new Set(), closure);
  const stamp = closureStamp(closure);
  if (cached && stamp !== null && stamp === cached.stamp) {
    return cached.def;
  }

  const def = protoLoader.loadSync(absPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.resolve(protoDir)],
  });
  // 闭包 stat 残缺(成员读得到 stat 不到)时退化为顶层指纹:宁可多重析,不缓存错 stamp
  const st = fs.statSync(absPath);
  cache.set(absPath, { def, stamp: stamp ?? `${st.mtimeMs}:${st.size}`, closure });
  return def;
}

export function clearPackageDefinitionCache(): void {
  cache.clear();
}
