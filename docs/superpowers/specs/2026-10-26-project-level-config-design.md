# 项目级配置文件 `.proto-utils/settings.json` 设计（0.3.82）

## 背景与目标

当前所有配置走 VS Code Settings（`protoUtils.runner.*` / `protoUtils.codeGen.*` / `protoUtils.scan.*`），
个人设置与工作区 `.vscode/settings.json` 均可覆盖，但缺少一个**进版本库、团队共享**的项目级配置入口。
项目已有 `.proto-utils/sequences.json`（ADR-0012）与 `.proto-utils/environments.json`（0.3.78）两个
工作区文件惯例，本设计新增第三个：`.proto-utils/settings.json`。

## 决策记录（已与用户逐条确认）

| 决策点 | 结论 |
|---|---|
| 形态 | 专用项目配置文件 `.proto-utils/settings.json`（方案 A） |
| 覆盖范围 | 全部配置项可覆盖，不设白名单；文件里没写的键回退 VS Code settings |
| 优先级 | `顶栏地址(workspaceState) > 项目文件 > VS Code 设置(工作区/用户) > 默认值` |
| 文件格式 | 扁平点分键、不带 `protoUtils.` 前缀，与 `resolveRunnerConfig(get)` 消费的键名一致 |
| 运行时 | 内存缓存 + FileSystemWatcher 失效；坏文件忽略 + 警告（去重） |
| 入口 | 新命令 `protoUtils.createProjectConfig`（ensureFile 模板 + 打开编辑器）；不做工作台 UI 标识 |

## 模块设计

### 1. `src/projectConfig.ts` — ProjectConfig 类

仿照 `Environments` / `SequenceStore` 模式：

- 构造：`ProjectConfig(workspaceRoot, fs = realFs)`，fs 注入 `SequenceStoreFs` 同款最小面（复用该接口），单测用内存替身。
- `reload()`：读 `.proto-utils/settings.json` 缓存为 `Record<string, unknown>`。
  - 文件缺失 → 空表（正常态，不算错）。
  - JSON 解析失败 / 顶层非对象 → 缓存置空 + 记 `error` 字符串（environments.json 同款语义）。
- `get(key): unknown`：命中缓存返回值，否则 `undefined`。
- `ensureFile()`：不存在时写模板并返回路径；已存在直接返回路径不覆盖。
- **模板所有示例键的值 = package.json 声明的默认值**（如 `"runner.timeoutMs": 15000`），
  新建文件本身不改变任何行为，避免"一创建模板就压掉用户 VS Code 设置"。
- 放置于 `src/` 顶层共享模块（与 `protoErrorMessage.ts` 同级），codegen 与 extension 静态 import，
  不走 runner 重 bundle 懒加载通道。

### 2. 分层 get 组合（不改解析逻辑）

`resolveRunnerConfig` / `resolveScanExcludes` / codegen 解析函数一行不改，只把传入的 `get` 换成分层版：

```
layeredGet(key) = projectConfig.get(key) ?? vscodeGet(key)
```

三个消费点：

1. **extension.ts**：activate 时有 wsRoot 才创建 `projectConfig` 并 `reload()`；
   现有 `getSetting`（扫描根 / scanExcludes）换成分层 get。
2. **runner 侧 `resolveRunnerConfig(persistedServer)` 包装（webviewPanel.ts）**：
   `ProjectConfig` 实例经 deps 注入（environments 同款通道），runner 只消费 `get(key)` 接口不 import 具体类。
   服务器地址优先级链最终为：`persistedServer(顶栏) > 项目文件 runner.server > VS Code settings 残值 > 默认`，
   与现有第三参回退逻辑天然兼容。
3. **codegen/command.ts**：`readConfig` / `readPathOptions` 从 `getConfiguration('protoUtils.codeGen')` 相对键
   改为根命名空间 `getConfiguration('protoUtils')` + `'codeGen.xxx'` 全键，项目文件命中 `codeGen.*` 优先；
   int64Style 降级等兜底逻辑原样保留。

### 3. watcher、警告与命令

- **watcher**：activate 顶层注册
  `createFileSystemWatcher(new RelativePattern(wsRoot, '.proto-utils/settings.json'))`。
  create/change/delete → `projectConfig.reload()` + 500ms 防抖 `workbench.reload()`
  （protoDir / scan.excludeDirs 变更需重扫）；面板已开时走现有 `notifyConfigChanged()` 推新 server/protoDir。
- **坏文件警告去重**：记 `lastWarnedError`，错误文本变化时才 `showWarningMessage`，避免 watcher 反复弹窗。
- **命令** `protoUtils.createProjectConfig`（"Proto Utils: 创建项目配置文件"）：
  无工作区 → 提示不可用；`ensureFile()` → `showTextDocument` 打开。
  package.json 注册 command + palette 菜单，标题走 `%key%` + `package.nls.json` / `package.nls.zh-cn.json` 双语。

## 测试计划

- `src/test/projectConfig.test.ts`（内存 fs）：
  - 缺失文件 → get 全 undefined、无 error；
  - 坏 JSON / 顶层非对象 → error 记录、缓存为空；
  - 合法文件 → get 命中/未命中；
  - ensureFile 首次写模板 / 已存在不覆盖。
- `runnerConfig.test.ts` 补分层用例：项目文件 > vscode get > 默认；persistedServer > 项目文件 `runner.server`。

## 文档与版本

- README / README.zh-CN 新增"项目级配置"小节：键名规则（设置项去掉 `protoUtils.` 前缀）、优先级链、文件示例。
- 版本升 **0.3.82**，按项目标注惯例同步（package.json / README 功能表）。

## 明确不做（YAGNI）

- 多根工作区仍只认第一个 workspace folder（与 sequences / environments 现状一致）。
- 不做工作台内"配置来自项目文件"的 UI 标识。
- 不做 JSON schema（`jsonValidation` contribution）——后续可加。
- 不做白名单过滤：项目文件写任何 `protoUtils` 键都参与覆盖。
