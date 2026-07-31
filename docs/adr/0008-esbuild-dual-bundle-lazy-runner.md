# esbuild 双 bundle:编辑器面与调用面分开打包

扩展从 tsc 直出切换到 esbuild:调用面引入 @grpc/grpc-js 与 @grpc/proto-loader 后,vsix 不能再假设 node_modules 可用(.vscodeignore 排除之),且这两个依赖不该拖慢编辑器功能激活。构建产出两个 bundle:out/extension.js(编辑器面,~300KB)与 out/runner/index.js(调用面,~1MB),后者只经动态 import 在首次打开工作台时 require(用户 spec 的懒加载约定);tsc 转为 --noEmit 只做类型检查。动态 import 必须带 .js 扩展名——CJS 里它走 ESM 解析器,无扩展名解析失败。
