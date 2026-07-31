import path from 'path';
import * as protoLoader from '@grpc/proto-loader';

const cache = new Map<string, protoLoader.PackageDefinition>();

/**
 * 调用面契约(keepCase:false/longs:Number/enums:Number/defaults:true/oneofs:true),
 * 逐字沿用 rpc_runner;与 emitter 平面的 ProtoFrontend(keepCase:true)互不共享。
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
    longs: Number,
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
