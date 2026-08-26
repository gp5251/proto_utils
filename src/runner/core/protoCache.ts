import path from 'path';
import fs from 'fs';
import * as protoLoader from '@grpc/proto-loader';

interface CacheEntry {
  def: protoLoader.PackageDefinition;
  /** mtimeMs:size 指纹(0.3.45):命中后 stat 校验,变更自动重析,不再依赖全清缓存。 */
  stamp: string;
}

const cache = new Map<string, CacheEntry>();

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
  // stat 先行:文件缺失时与 loadSync 同样抛错,由调用方按 per-file 收集
  const st = fs.statSync(absPath);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const cached = cache.get(absPath);
  if (cached && cached.stamp === stamp) {
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
  cache.set(absPath, { def, stamp });
  return def;
}

export function clearPackageDefinitionCache(): void {
  cache.clear();
}
