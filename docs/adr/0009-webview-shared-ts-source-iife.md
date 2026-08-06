# webview 与扩展共享同一份 TS 源:esbuild iife 桥接为浏览器全局

ADR-0008 的两个 bundle(out/extension.js + out/runner/index.js 懒加载)之外,出现第三个产品 artifact:`media/runner/formMapping.js`。

背景:JSON 直输双模式编辑器(同步 rpc_runner 702879a)的 JSON↔表单映射逻辑需要同一份代码在三处运行——扩展宿主、webview 浏览器、node:test 单测。方案:单一 TS 源 `src/runner/utils/formMapping.ts`,宿主与测试直接 import;build.mjs 第四个 esbuild bundle(`format:'iife'`、`globalName:'FormMapping'`、`platform:'browser'`)产出浏览器全局 `window.FormMapping`,webview 经 asWebviewUri 加载。测的就是浏览器执行的那份代码。

伴随约束:

- HTML 中 formMapping.js 必须先于 runner.js 加载(runner.js 的状态机同步调 window.FormMapping);CSP nonce 同源,加载顺序有锚点测试守护。
- 生成物不入库:.gitignore 排 `media/runner/formMapping.js*`(含 dev sourcemap),.vscodeignore 排 `media/**/*.map`,防 dev 遗留 sourcemap 进 vsix。

否决纯 JS + .d.ts 旁置(rpc_runner 的 UMD 路线):双写要手工保 .d.ts 与实现同步;TS 单一事实源让 tsc 类型全通,esbuild 一步到浏览器,无需维护旁置声明。
