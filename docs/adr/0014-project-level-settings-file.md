# 项目级配置文件：.proto-utils/settings.json

插件配置此前只走 VS Code Settings，缺少进版本库、团队共享的项目级入口。我们决定新增 `.proto-utils/settings.json`（扁平点分键、不带 `protoUtils.` 前缀，与 `resolveRunnerConfig` 的 get 键名一致），与 sequences.json（ADR-0012）、environments.json（0.3.78）同目录同惯例；实现上**不改任何解析函数**，只把三个消费点的 `get` 换成分层版 `projectConfig.get(key) ?? vscodeGet(key)`。优先级：顶栏地址(workspaceState) > 项目文件 > VS Code 设置 > 默认值。

## Considered Options

- **只用 VS Code 原生机制（.vscode/settings.json 工作区覆盖）**：零新概念，但该目录常被 gitignore、共享与否不可控，且无模板/校验入口，弃。
- **键名白名单（只开放“适合项目级”的子集）**：边界更干净，但要维护名单，用户写了不生效反而困惑，弃——全部键可覆盖，语义统一为“项目文件即团队共识默认值”。

## Consequences

- 项目文件里的键压过个人 VS Code 设置：个人要让位只能删项目文件里的键（团队契约优先，有意为之）。
- 扫描根(protoDir)与排除集(scan.excludeDirs)仍烤在激活时：项目文件改这两项与改 VS Code 设置同款限制——需 reload 窗口；其余键经 watcher 热更新即时生效。
- 文件格式一旦发布即成契约（沿用“只增不改”惯例）；坏 JSON 整文件忽略 + 去重警告，绝不半生效。
- 模板键值 = package.json 默认值：`createProjectConfig` 创建文件本身不改变任何行为。
