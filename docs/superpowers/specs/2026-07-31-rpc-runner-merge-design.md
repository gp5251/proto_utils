# RPC Runner 合并设计 — rpc_runner 功能整合进 proto-utils 扩展

日期：2026-07-31
状态：已批准（方案 A：直连移植）

## Problem Statement

`rpc_runner`（D:\projects\rpc_runner）是一个独立的 Express + EJS Web 应用，提供"gRPC 版 Postman"能力：扫描 proto 目录、提取 service/method/字段 schema、渲染动态表单、通过 `@grpc/grpc-js` 发起 unary 调用并展示响应。`proto-utils` 是一个零依赖 VS Code 扩展，提供 proto3 语法高亮、跳转定义、TS 代码生成。

目标：把 rpc_runner 的 gRPC 调用能力**作为功能整合进 proto-utils 扩展**（webview 面板形态），合并完成后 rpc_runner 仓库归档。两个产品合一，开发者在编辑器里即可从 proto 文件直接发起 RPC 调用。

## Approach：方案 A — 直连移植

核心原则：**纯逻辑模块原样搬，宿主壳重写**。

rpc_runner 的 schema 提取（`protoLoader.ts`）和 wire 调用（`grpcClient.ts`）都基于 `@grpc/proto-loader`，二者天然一致且已被 vitest 测试覆盖。移植时保持这条链路不动，只替换外围：Express 路由 → webview 消息、EJS → TS 模板函数、SSE → `postMessage`、chokidar → VS Code `FileSystemWatcher`、`rpc.config.json` → VS Code settings。

### 已否决的备选方案

- **方案 B（统一 AST）**：表单 schema 改从扩展自研 parser/符号索引生成。调用时 proto-loader 仍绕不开，双重解析并未消除，反而要新写 AST→FieldInfo 桥接层并重新验证 proto3 optional/oneof/map/跨文件同名合并等边缘语义。工作量 2-3 倍，且引入两个 schema 模型需长期保持一致的负担。未来如需，可在 `serviceRegistry` 的 schema 来源接口后替换实现，方案 A 不挡路。
- **方案 C（内嵌服务器）**：扩展 spawn Express + webview iframe。端口冲突、进程生命周期、webview CSP 三层脆弱点，UX 差，与编辑器无联动。

## Architecture

### 模块映射

| rpc_runner 模块 | 去向 | 改动 |
|---|---|---|
| `core/protoLoader.ts` | `src/runner/core/protoLoader.ts` | 原样；`protoDir` 由新 config 注入 |
| `core/protoCache.ts` | `src/runner/core/` | 原样 |
| `core/protoFingerprint.ts` | `src/runner/core/` | 原样 |
| `core/grpcClient.ts` | `src/runner/core/` | 原样 |
| `core/types.ts` | `src/runner/core/` | 原样 |
| `core/servicesDiskCache.ts` | `src/runner/core/` | 原样；缓存目录由调用方注入（原写入 `generatedDir`，改到 `context.globalStorageUri` 下） |
| `utils/formParser.ts` / `schemaRows.ts` / `display.ts` / `enumDisplay.ts` / `formatGrpcError.ts` / `protoComments.ts` / `protoEncoding.ts` | `src/runner/utils/` | 原样 |
| `core/configLoader.ts` | `src/runner/config.ts` | **重写**：读 VS Code settings，不再读 `rpc.config.json` |
| `routes/home.ts`（服务缓存、后台加载、序列化） | `src/runner/serviceRegistry.ts` | 剥掉 Express 类型；缓存/后台解析/指纹失效逻辑保留 |
| `routes/call.ts`（表单值→请求对象→调用） | `src/runner/callHandler.ts` | 剥掉 Express，变为纯函数：`(service, method, values) → CallResult payload`；`GrpcClient` 工厂注入以便测试 |
| `views/home.ejs` + `layout.ejs` | `src/runner/webviewHtml.ts`（HTML 模板函数）+ `media/runner/`（静态资源） | EJS → TS 模板字符串；Alpine.js 前端逻辑保留，3 个 `fetch` 调用点改为消息收发 |
| `core/protoWatcher.ts`（chokidar） | 删除 | 复用扩展 `FileSystemWatcher`（见"proto 变更流"） |
| `core/sseHub.ts` / `routes/events.ts` | 删除 | `webview.postMessage` 替代 SSE |
| `core/typeGenerator.ts` + `proto-loader-gen-types` | 删除 | 扩展自身 codegen 已覆盖 TS 类型生成 |
| `index.ts` / `server.ts` / `rpc.config.json` / inquirer CLI | 删除 | 宿主就是 VS Code |

### 目录结构（合并后新增部分）

```
src/
  runner/
    core/            # protoLoader, protoCache, protoFingerprint, grpcClient, servicesDiskCache, types
    utils/           # formParser, schemaRows, display, enumDisplay, formatGrpcError, protoComments, protoEncoding
    config.ts        # VS Code settings 读取
    serviceRegistry.ts
    callHandler.ts
    webviewPanel.ts  # 面板创建/单例/消息路由
    webviewHtml.ts   # HTML 生成（CSP nonce、内嵌序列化数据）
  test/
    runner/          # 移植的测试（见 Testing）
media/
  runner/
    alpine.min.js    # vendored Alpine.js
    runner.css       # layout.ejs 的样式
    runner.js        # home.ejs 的 Alpine 前端逻辑
```

### 激活与生命周期

- `package.json` 新增：
  - 命令 `protoUtils.openRpcRunner`（标题 "Proto Utils: Open RPC Runner"），出现在命令面板与 `.proto` 编辑器右键菜单
  - `activationEvents` 增加 `onCommand:protoUtils.openRpcRunner`
  - 配置节 `protoUtils.runner.*`（见"配置面"）
- 命令处理器内 `await import('./runner/webviewPanel')` **懒加载**：`@grpc/grpc-js`、`@grpc/proto-loader` 只在首次打开面板时载入，编辑器功能（高亮/跳转/codegen）的激活路径不受影响。
- 面板单例 + `retainContextWhenHidden: true`：重复执行命令聚焦已有面板；切 tab 表单状态不丢。

### Webview 消息协议（替代 HTTP 路由）

webview → extension：

| 消息 | 替代 | 说明 |
|---|---|---|
| `{ type: 'ready' }` | 首屏 `GET /` | 面板就绪，请求服务数据 |
| `{ type: 'call', service, method, values }` | `POST /api/call` | 发起调用 |
| `{ type: 'refresh' }` | 手动刷新页面 | 强制重新解析 proto |

extension → webview：

| 消息 | 替代 | 说明 |
|---|---|---|
| `{ type: 'loading' }` | `/api/services/status` 轮询 | 后台解析中 |
| `{ type: 'services', payload }` | EJS 内嵌数据 | `serializeServicesForClient` 原样复用 |
| `{ type: 'loadError', errors }` | EJS 错误卡片 | proto 解析失败 |
| `{ type: 'callResult', payload }` | `/api/call` 响应体 | 与 rpc_runner 响应同构（含 `fields`/`values`/`result`/`resultBody`） |

### proto 变更流

扩展 `FileSystemWatcher`（`**/*.proto`）回调 → `serviceRegistry.invalidate()` + 触发 `convertProtosToUtf8`（编码转换逻辑原样保留）→ 后台重新解析 → 完成后向面板推送 `services`。webview 端用 Alpine 响应式赋值更新服务列表，**不整页刷新**（原方案的 `location.reload()` 被消除，表单状态保留）。

### Webview 技术与 CSP

- Alpine.js 以 minified 单文件 vendored 到 `media/runner/alpine.min.js`，经 `asWebviewUri` + nonce 加载（webview CSP 禁止远程脚本，原 layout.ejs 的 CDN 引用不可再用）。
- CSP：`default-src 'none'; style-src <cspSource> 'unsafe-inline'; script-src 'nonce-<random>'`。
- 590 行 home.ejs 的服务端渲染部分（loading 卡片、错误卡片、空态）改为 `webviewHtml.ts` 中按状态生成的静态 HTML；客户端交互（过滤、折叠、表单、调用、结果渲染）原样保留为 Alpine 组件。

## 配置面

`rpc.config.json` → VS Code settings（`package.json` 的 `contributes.configuration`）：

| 设置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `protoUtils.runner.server` | string | `"localhost:50051"` | gRPC 服务器地址（host:port） |
| `protoUtils.runner.protoDir` | string | `""` | proto 目录；空 = 工作区根目录；相对路径相对于 workspace folder 解析 |

删除：`port`（无 HTTP 服务）、`generatedDir`（typeGenerator 已删）。

`config.ts` 设计为纯函数 `resolveRunnerConfig(get: (key: string) => unknown, workspaceRoot: string): RunnerConfig` + 薄 vscode 适配层，纯函数可测。per-workspace settings 天然支持多项目不同服务器。

已有 rpc_runner 用户迁移：手动把 `server`、`protoDir` 两个值抄到 VS Code settings，README 写明。

## 依赖与打包

- 新增 runtime dependencies：`@grpc/grpc-js`、`@grpc/proto-loader`（均为纯 JS，全平台可用，无原生编译）。
- Alpine.js：作为 devDependency 安装，构建脚本拷贝 `alpinejs/dist/cdn.min.js` → `media/runner/alpine.min.js`（可随依赖更新）。
- 打破 SPEC.md 的"零外部依赖"原则——**仅限 runner 功能路径**：编辑器功能仍零依赖；懒加载保证未使用 runner 时这些依赖不被载入。SPEC.md 相应条目需更新。
- vsix 体积增大约 3-5 MB（grpc-js 依赖树）。`.vscodeignore` 需确认 `media/runner/` 与 runtime deps 的 `node_modules` 被打包、`src/` 与 devDeps 被排除。
- 测试脚本从 `node --test out/test/*.test.js` 改为 `node --test out/test`（目录参数递归匹配所有 `*.test.js`，避免 Windows 下 glob 展开问题）。

## 错误处理

全部沿用 rpc_runner 已验证的逻辑，仅改呈现层：

- **proto 解析失败**：`serviceRegistry` 收集错误 → `loadError` 消息 → webview 错误卡片（原 EJS 错误卡片移植）。
- **调用失败**：`formatGrpcError` 原样复用，错误文本进 `callResult.payload.resultBody` 展示。
- **非 UTF-8 proto**：`protoEncoding` 的 GBK→UTF-8 自动转码原样保留，转码数量经 `vscode.window.showInformationMessage` 提示（替代原来的 `console.log`）。
- **配置缺失**：`protoDir` 目录不存在或无 proto 文件 → webview 空态卡片（原"未找到服务"空态移植，文案指向 settings）。

## Testing

测试运行器保持 Node 内置 `node:test` + `assert`（与扩展现状一致），**不引入 vitest**。rpc_runner 的 9 个 vitest 测试文件机械转换后放 `src/test/runner/`：

| 原测试 | 处理 |
|---|---|
| `configLoader.test.ts` | 重写：测 `resolveRunnerConfig` 纯函数（默认值、部分配置、非法值回退），不再碰临时文件 |
| `protoLoader.test.ts` / `servicesDiskCache.test.ts` | 语法转换（describe/it/expect → test/assert），逻辑不动 |
| `display` / `enumDisplay` / `formParser` / `formatGrpcError` / `protoComments` / `protoEncoding` / `schemaRows` 各测试 | 语法转换，逻辑不动 |

新增测试：

- `callHandler.test.ts`：注入 mock `GrpcClient` 工厂，覆盖 form values → request 对象 → 调用 → payload 组装路径（成功、调用错误、非法 JSON raw 值回退）。
- `webviewHtml.test.ts`：生成的 HTML 含 CSP nonce、序列化 services 数据正确转义（`</script>` 注入防护）。

不测（与两个项目现状一致）：`GrpcClient` 真实调用（需活体服务器）、webview UI 交互（手动验证）、VS Code provider 集成。

## 删减清单（明确不迁移）

- Express / express-ejs-layouts / EJS 视图引擎
- SSE（`sseHub`、`/api/events`）
- chokidar（由 VS Code watcher 替代）
- inquirer CLI 入口
- `typeGenerator` + `proto-loader-gen-types`（扩展 codegen 已覆盖）
- `port` / `generatedDir` 配置
- vitest

## 迁移与收尾

1. 代码迁移 + 测试移植 + 手动验证（打开面板、选方法、调活体服务器、改 proto 自动刷新）。
2. 更新 proto-utils `README.md`（runner 功能、配置项、从 rpc.config.json 的迁移说明）与 `SPEC.md`（零依赖原则的限定表述）。
3. 把 rpc_runner `docs/superpowers/` 下的历史 spec 拷贝到 `docs/superpowers/specs/archive/rpc-runner/` 保留历史。
4. 验证通过后由用户归档 rpc_runner 仓库。

## Out of Scope

- streaming RPC（client/server/bidi）——rpc_runner 现状即仅支持 unary
- 多服务器配置 / 环境切换（postman environments 式）
- 表单字段 ↔ proto 定义跳转联动（方案 B 的卖点之一，留作未来增强）
- AST 统一（方案 B）
- gRPC 反射、TLS/mTLS 连接配置（rpc_runner 现状不支持，不新增）
- 请求历史 / 收藏 / 导入导出

## Further Notes

- `servicesDiskCache` 原写入 `generatedDir`；合并后缓存文件放 `context.globalStorageUri` 目录，指纹（`protoFingerprint`）机制不变。
- home.ejs 的 Alpine 组件中 3 个网络调用点（`fetch /api/call`、`fetch /api/services/status` 轮询、`EventSource /api/events`）是仅有的网络依赖，替换为消息收发后其余前端逻辑原样。
- `serializeServicesForClient` 的输出结构是 webview 前端的数据契约，移植时字段名不得改动。
