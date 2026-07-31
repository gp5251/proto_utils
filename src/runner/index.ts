/**
 * 调用面懒加载入口:extension.ts 只动态 import 本模块,
 * esbuild 把它打成独立 bundle(out/runner/index.js),grpc-js/protobufjs
 * 不进编辑器激活路径(用户 spec 的懒加载约定)。
 */
export { WorkbenchPanelManager, createVscodePanelFactory, resolveRunnerConfig } from './webviewPanel';
export { ServiceRegistry } from './serviceRegistry';
export { GrpcCallRunner } from './callHandler';
