# rpc_runner 设计文档

## 概述

一个 TypeScript CLI 工具，用于快速调试 gRPC 接口：添加 proto 文件后，交互式选择服务和接口，填入 JSON 请求参数，调用真实 gRPC server 并查看返回结果。同时支持命令行一键调用模式。

## 技术选型

- **gRPC client**: `@grpc/grpc-js` + `@grpc/proto-loader`
- **Proto → TypeScript 类型**: `proto-loader-gen-types` 从 proto 自动生成 `.ts` 类型文件
- **交互式 CLI**: `inquirer`
- **命令行参数**: 直接解析 `process.argv`
- **语言**: TypeScript，编译到 Node.js

## 项目结构

```
rpc_runner/
├── protos/                    # 放置 .proto 文件
│   └── generated/             # 自动生成的 TS 类型文件
├── src/
│   ├── index.ts               # 入口，分发交互/命令行模式
│   ├── cli/
│   │   ├── interactive.ts     # Inquirer 交互流程
│   │   └── command.ts         # 命令行解析 + 直接调用
│   ├── core/
│   │   ├── protoLoader.ts     # 扫描 proto 目录，loadSync 加载
│   │   ├── typeGenerator.ts   # 调用 proto-loader-gen-types 生成 TS 类型
│   │   ├── grpcClient.ts      # gRPC 连接 + 反射调用
│   │   └── types.ts           # 内部类型定义
│   └── utils/
│       └── display.ts         # 响应格式化输出
├── rpc.config.json            # 配置文件
├── package.json
└── tsconfig.json
```

## 配置

`rpc.config.json`：

```json
{
  "server": "localhost:50051",
  "protoDir": "./protos",
  "generatedDir": "./protos/generated"
}
```

- `server` — gRPC 服务端地址，可通过环境变量 `RPC_SERVER` 覆盖
- `protoDir` — proto 文件目录，工具扫描此处所有 `.proto` 及子目录
- `generatedDir` — 自动生成的 TypeScript 类型文件输出目录

首次运行无配置文件时，交互式提示填写并自动写入。

## 核心流程

### 启动 → 准备

1. 读取 `rpc.config.json`，合并环境变量覆盖
2. 扫描 `protoDir` 下所有 `.proto` 文件
3. 调用 `@grpc/proto-loader` 的 `loadSync()` 加载全部 proto，得到 `packageDefinition`

   选项：
   - `keepCase: false` — proto 字段自动 camelCase
   - `enums: Number`
   - `longs: Number`
   - `oneofs: true`
   - `includeDirs: [protoDir]` — 解析 proto `import`

4. 检查 `generatedDir` 中类型文件是否存在/过期；如需要，调用 `proto-loader-gen-types` 重新生成
5. 从 `packageDefinition` 提取所有 service、method、请求/响应消息名称
6. 建立 gRPC channel（insecure credentials）

### 交互模式

1. **选择 service** — 从所有发现的 service 列表中选择
2. **选择 method** — 从当前 service 的 rpc 方法列表中选
3. **填写请求参数** — 展示请求消息的字段结构（来自生成的 TS 类型），用户输入 JSON；字段类型已知则做自动转换和校验
4. **执行调用** — promisify 的 unary call
5. **展示结果** — 格式化 JSON 输出，标注请求耗时和状态

### 命令行模式

```
rpc-runner call <Service.Method> '<json>'
```

- 跳过交互，直接执行调用
- 输出同上

### gRPC 调用细节

- 不依赖 server reflection，完全从本地 proto 解析
- 使用 `loadSync` 返回的 `packageDefinition` 中的 service constructor 动态创建 client
- 所有调用为 unary，promisify 处理
- 使用 insecure channel（`grpc.credentials.createInsecure()`）
- 多服务共享同一 channel

## 错误处理

- proto 文件不存在或解析失败 → 明确报错并退出
- gRPC 服务不可达 → 超时提示 + 错误信息
- RPC 调用失败 → 展示 gRPC status code + message
- JSON 参数格式错误 → 提示具体字段问题

## 不做的

- 不生成测试代码文件（spec/test）
- 不支持 streaming RPC
- 不支持 TLS/mTLS
- 不做 server reflection
- 不保存请求历史
