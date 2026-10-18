# Client-streaming 与双向流采用显式会话

状态：accepted；部分取代 ADR-0007。

工作台从 0.3.78 起支持 client-streaming 与 bidi-streaming：用户先打开流，再把当前请求表单逐条写入，最后显式结束发送；bidi 响应沿用服务端流的 chunk 展示与取消机制。选择会话式 UI 而非一次提交请求数组，是因为它保留 gRPC 写侧的实时性与半关闭语义，并让四种 RPC 方向共享同一套 metadata、读侧事件和结果展示。

## Consequences

- client-streaming 的单条最终响应也作为一个响应 chunk 展示；bidi 可边发送边接收。
- 「结束发送」仅 half-close 写侧，「取消」终止整条流；二者语义不可互换。
- 流式会话不设置总 deadline，也不进入请求历史；调用序列仍只支持一元与服务端流步骤。
