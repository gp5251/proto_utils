import path from 'path';
import * as protoLoader from '@grpc/proto-loader';

const cache = new Map<string, protoLoader.PackageDefinition>();

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
  const cached = cache.get(absPath);
  if (cached) {
    return cached;
  }

  const def = protoLoader.loadSync(absPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.resolve(protoDir)],
  });
  cache.set(absPath, def);
  return def;
}

export function clearPackageDefinitionCache(): void {
  cache.clear();
}
