# CodeLens 入口 + Webview 工作台

发起 RPC 调用的主入口下沉到编辑器:位置索引层标出每个 rpc 方法定义,CodeLens 在其上方渲染「▶ 调用」,点击后 Webview 工作台打开并预选该服务/方法;填参、调用、看响应都在 Webview。Webview 面板也可用命令独立打开(下拉选服务/方法),覆盖 proto 文件未打开的场景。否决纯面板模式:那只是把 rpc_runner 嵌进编辑器,入口不下沉,合并的产品价值(读 proto → 点 → 调用的闭环)就不成立。
