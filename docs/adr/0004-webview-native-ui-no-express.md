# 调用界面用 VS Code Webview 原生重写,Express/EJS 废弃

rpc-runner 的 Express + EJS 服务端渲染 UI(~1100 行 EJS + routes)不进扩展,调用界面用 Webview 原生 HTML/JS 重写,经 postMessage 与扩展宿主通信;SSE 热更新由 VS Code 文件 watcher → postMessage 替代。否决「扩展内嵌 Express + iframe」是因为扩展不该背负 HTTP 服务生命周期(端口、CSP、多窗口),且那只是在编辑器里嵌一个旧网页。真正值钱的资产是 UI 无关的纯函数层(formParser / schemaRows / protoEncoding / enumDisplay,均带 vitest 测试),原样搬入扩展复用。
