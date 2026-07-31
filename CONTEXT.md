# Proto Utils

一个 VS Code 扩展:proto3 文件的编辑辅助(高亮、跳转、代码生成)与 gRPC 请求调用,在同一个工具内完成。由 proto-utils 扩展吸收 rpc-runner 工具合并而成。

## Language

**Proto Utils(扩展)**:
合并后唯一存活的产品形态:VS Code 扩展。所有 proto 相关能力(编辑、生成、调用 RPC)都交付在这里。
_Avoid_: proto-utils 插件、新仓库

**RPC Runner(被合并)**:
原独立 Node CLI + Express/EJS Web 工具(`D:\projects\rpc_runner`),其 gRPC 调用能力被并入扩展后,该仓库归档退役。
_Avoid_: rpc-runner 服务、老工具

**合并(Merge)**:
把 RPC Runner 的 gRPC 调用能力吞进 Proto Utils 扩展,Express/EJS 服务端渲染 UI 废弃,替换为 VS Code Webview。不是把两个仓库并排放进 monorepo。
_Avoid_: 搬家、并仓

**语义前端**:
`@grpc/proto-loader`(protobufjs),扩展内唯一有权解析 proto 语义、判定文件合法性的组件。调用面的反射数据和代码生成的输入都来自它。
_Avoid_: parser、自研解析器(已随 ADR-0002 退役)

**位置索引层**:
只扫描 proto 文件里定义点(名字 + range)的薄组件,为 go-to-def 和语义高亮供数据。零语义:不解析 import、不判类型、不验合法性,因此永远不与语义前端矛盾。
_Avoid_: 解析器、AST、符号索引(旧 symbolIndex 的接替者,但不是同一物)

**工作台(Workbench)**:
发起和管理 RPC 调用的 Webview 面板:填参表单、发起调用、查看响应(含服务端流的流式追加)。由编辑器里 rpc 方法上方的「▶ 调用」CodeLens 唤起并预选方法,也可独立命令打开。
_Avoid_: 面板、页面、EJS 页面(旧实现,已废弃)
