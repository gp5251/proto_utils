# 调用支持一元 + 服务端流,client/bidi 流不做

状态：partially superseded by ADR-0013。

合并后的调用面支持一元调用和 server-streaming(响应区流式追加),不支持 client-streaming / 双向流。依据:rpc_runner 原为纯一元(代码里无任何流式分支,流式方法会以错误签名调用而失败),而真实 proto 语料有 3 个文件含 stream 方法——纯平价会让这些方法在新工具里依然调不了;server-streaming 在 grpc-js 里只是 EventEmitter,Webview 响应区流式渲染成本可控。client/bidi 当时需要上传式 UI,偏离合并目标,列为后续版本；0.3.78 已由 ADR-0013 的显式流会话补齐。
