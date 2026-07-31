# 吸收 rpc-runner 进 VS Code 扩展

proto-utils(VS Code 扩展)与 rpc-runner(独立 CLI + Express/EJS Web 工具)合并的终态:rpc-runner 的 gRPC 调用能力全部并入 proto-utils 扩展,UI 用 VS Code Webview 重写,Express/EJS 废弃,rpc_runner 仓库归档。选全吞而非 monorepo 共享内核,是因为用户价值在「编辑器内闭环」——读 proto、生成类型、发请求不离开 VS Code;保留独立服务端产品会让两个 UI 形态长期双维护。
