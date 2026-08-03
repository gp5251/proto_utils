/**
 * 调用面懒加载入口:extension.ts 只动态 import 本模块,
 * esbuild 把它打成独立 bundle(out/runner/index.js),grpc-js/protobufjs
 * 不进编辑器激活路径(ADR-0008)。
 */
export { WorkbenchSession } from './workbenchSession';
export type { WorkbenchHost, WorkbenchToWebview, WebviewToWorkbench } from './workbenchSession';
export { ServiceRegistry } from './serviceRegistry';
export { GrpcCallRunner } from './callHandler';
