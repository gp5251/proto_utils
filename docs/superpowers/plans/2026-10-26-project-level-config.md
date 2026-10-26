# 项目级配置文件 `.proto-utils/settings.json` 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增项目级配置文件 `.proto-utils/settings.json`（进版本库、团队共享），覆盖全部 `protoUtils.*` 设置项，优先级 `顶栏地址(workspaceState) > 项目文件 > VS Code 设置 > 默认值`。

**Architecture:** 新共享模块 `src/projectConfig.ts`（缓存 + 注入式 fs，仿 `Environments`/`SequenceStore` 模式）；不改任何解析函数，只把三个消费点（extension 激活路径、runner 侧 `resolveRunnerConfig` 包装、codegen `readConfig`/`readPathOptions`）传入的 `get` 换成分层版 `projectConfig.get(key) ?? vscodeGet(key)`；activate 顶层加 settings.json watcher + 去重警告 + `createProjectConfig` 命令。

**Tech Stack:** TypeScript、esbuild 双 bundle、node:test（`npm test` = build + `node --test out/test/*.test.js`）。

**Spec:** `docs/superpowers/specs/2026-10-26-project-level-config-design.md`

**验证命令（全局）：**
- 构建+全部测试：`npm test`（PowerShell，工作目录 `d:\projects\proto_utils`）
- 类型检查：`npm run typecheck`
- 单跑一个测试文件：`node --test out/test/projectConfig.test.js`（需先 `node scripts/build.mjs`）

---

### Task 1: `ProjectConfig` 模块（TDD）

**Files:**
- Create: `src/projectConfig.ts`
- Test: `src/test/projectConfig.test.ts`

- [ ] **Step 1.1: 写失败测试**

创建 `src/test/projectConfig.test.ts`（内存 fs 替身，模式同 `sequenceStore.test.ts`；错误构造 `Object.assign(new Error('ENOENT'), { code: 'ENOENT' })` 满足 `isNotFound` 判定）：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ProjectConfig, SETTINGS_FILE } from '../projectConfig';
import { SEQUENCE_DIR, type SequenceStoreFs } from '../runner/sequenceStore';

/** 内存 fs 替身:files 键为绝对路径。 */
function memFs(files: Record<string, string> = {}): SequenceStoreFs & { files: Record<string, string> } {
  return {
    files,
    readFile: async (f) => {
      if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[f];
    },
    writeFile: async (f, d) => void (files[f] = String(d)),
    mkdir: async () => undefined,
  };
}

const ROOT = path.resolve('/ws');
const FILE = path.join(ROOT, SEQUENCE_DIR, SETTINGS_FILE);

test('缺失文件 → get 全 undefined,无 error(正常空态)', async () => {
  const pc = new ProjectConfig(ROOT, memFs());
  await pc.reload();
  assert.equal(pc.error, undefined);
  assert.equal(pc.get('runner.timeoutMs'), undefined);
});

test('坏 JSON → error 记录,缓存为空', async () => {
  const pc = new ProjectConfig(ROOT, memFs({ [FILE]: '{oops' }));
  await pc.reload();
  assert.match(pc.error ?? '', /not valid JSON/);
  assert.equal(pc.get('runner.timeoutMs'), undefined);
});

test('顶层非对象(数组/标量)→ error 记录', async () => {
  const pc = new ProjectConfig(ROOT, memFs({ [FILE]: '[1,2]' }));
  await pc.reload();
  assert.match(pc.error ?? '', /must be an object/);
});

test('合法文件 → get 命中/未命中;值原样返回', async () => {
  const pc = new ProjectConfig(ROOT, memFs({ [FILE]: JSON.stringify({ 'runner.timeoutMs': 3000, 'scan.excludeDirs': ['third_party'] }) }));
  await pc.reload();
  assert.equal(pc.get('runner.timeoutMs'), 3000);
  assert.deepEqual(pc.get('scan.excludeDirs'), ['third_party']);
  assert.equal(pc.get('codeGen.outputDir'), undefined);
});

test('reload 重读:文件修复后 error 清空', async () => {
  const fs = memFs({ [FILE]: '{oops' });
  const pc = new ProjectConfig(ROOT, fs);
  await pc.reload();
  assert.ok(pc.error);
  fs.files[FILE] = JSON.stringify({ 'runner.protoDir': 'proto' });
  await pc.reload();
  assert.equal(pc.error, undefined);
  assert.equal(pc.get('runner.protoDir'), 'proto');
});

test('ensureFile:首次写模板(模板自身是合法 JSON);已存在不覆盖', async () => {
  const fs = memFs();
  const pc = new ProjectConfig(ROOT, fs);
  const p = await pc.ensureFile();
  assert.equal(p, FILE);
  const written = fs.files[FILE];
  assert.ok(written);
  const parsed = JSON.parse(written) as Record<string, unknown>;
  // 模板值 = package.json 默认值:创建文件本身不改变任何行为
  assert.equal(parsed['runner.timeoutMs'], 15000);
  assert.equal(parsed['codeGen.outputDir'], 'generated');

  fs.files[FILE] = '{"runner.protoDir":"mine"}';
  await pc.ensureFile();
  assert.equal(fs.files[FILE], '{"runner.protoDir":"mine"}');
});
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `node scripts/build.mjs; node --test out/test/projectConfig.test.js`
Expected: 构建失败（`Could not resolve "../projectConfig"`）或测试 FAIL —— 模块尚不存在。

- [ ] **Step 1.3: 写实现**

创建 `src/projectConfig.ts`：

```ts
import path from 'node:path';
import { SEQUENCE_DIR, isNotFound, realFs, type SequenceStoreFs } from './runner/sequenceStore';

/**
 * 项目级配置(0.3.82):工作区文件 .proto-utils/settings.json,扁平点分键、
 * 不带 'protoUtils.' 前缀(与 resolveRunnerConfig 的 get 键名一致),形如
 *   { "runner.protoDir": "proto", "codeGen.outputDir": "src/generated" }
 * 优先级:项目文件 > VS Code settings > 默认(服务器地址除外:顶栏编辑持久化值最高)。
 * 进版本库、团队共享,与 sequences.json / environments.json 同目录同惯例(ADR-0014)。
 * fs 与 workspaceRoot 构造注入,单测用内存替身(SequenceStoreFs 同款最小面;仅 type import,不拖 runner bundle)。
 */
export const SETTINGS_FILE = 'settings.json';

/** 模板值一律 = package.json 声明的默认值:创建文件本身不改变任何行为,改哪个键哪个生效。 */
const TEMPLATE: Record<string, unknown> = {
  'runner.protoDir': '',
  'runner.timeoutMs': 15000,
  'runner.connProbeIntervalMs': 5000,
  'runner.metadata': [],
  'scan.excludeDirs': [],
  'codeGen.outputDir': 'generated',
  'codeGen.enumStyle': 'enum',
  'codeGen.optionalMessageFields': true,
  'codeGen.optionalScalarFields': false,
  'codeGen.fieldNaming': 'camelCase',
  'codeGen.pathMapping': 'file',
  'codeGen.importExtension': 'ts',
  'codeGen.oneofStyle': 'optional',
  'codeGen.int64Style': 'number',
};

export class ProjectConfig {
  private readonly file: string;
  private data: Record<string, unknown> = {};
  private lastError: string | undefined;
  /** 文件存在但解析失败时的原因;此时缓存为空(缺失文件不算错)。 */
  get error(): string | undefined {
    return this.lastError;
  }
  /** 当前配置文件绝对路径(供命令打开/警告展示)。 */
  get filePath(): string {
    return this.file;
  }

  constructor(
    workspaceRoot: string,
    private readonly fs: SequenceStoreFs = realFs,
  ) {
    this.file = path.join(workspaceRoot, SEQUENCE_DIR, SETTINGS_FILE);
  }

  async reload(): Promise<void> {
    this.data = {};
    this.lastError = undefined;
    let text: string;
    try {
      text = await this.fs.readFile(this.file);
    } catch (err) {
      if (!isNotFound(err)) this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.lastError = `${SETTINGS_FILE} is not valid JSON`;
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.lastError = `${SETTINGS_FILE} top level must be an object`;
      return;
    }
    this.data = parsed as Record<string, unknown>;
  }

  /** 命中返回值(可能是 null/false 等 falsy,分层方用 ?? 组合时注意只有 undefined/null 才回退);未命中 undefined。 */
  get(key: string): unknown {
    return this.data[key];
  }

  /** 文件不存在时写入模板;返回文件路径供编辑器打开(Environments.ensureFile 同款)。 */
  async ensureFile(): Promise<string> {
    try {
      await this.fs.readFile(this.file);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.fs.mkdir(path.dirname(this.file));
      await this.fs.writeFile(this.file, JSON.stringify(TEMPLATE, null, 2) + '\n');
      await this.reload();
    }
    return this.file;
  }
}
```

- [ ] **Step 1.4: 跑测试确认通过**

Run: `node scripts/build.mjs; node --test out/test/projectConfig.test.js`
Expected: 全部 PASS（6 tests）。

- [ ] **Step 1.5: Commit**

```powershell
git add src/projectConfig.ts src/test/projectConfig.test.ts
git commit -m "feat: ProjectConfig module for .proto-utils/settings.json"
```

---

### Task 2: runner 侧 `resolveRunnerConfig` 支持分层 get

**Files:**
- Modify: `src/runner/webviewPanel.ts:776-797`（vscode 粘合层的 `resolveRunnerConfig` 包装）
- Modify: `src/extension.ts:224-233`（buildManager 内两处调用点）
- Test: `src/test/runnerConfig.test.ts`（末尾追加）

- [ ] **Step 2.1: 写失败测试（分层优先级链）**

在 `src/test/runnerConfig.test.ts` 末尾追加（文件已 import `resolveRunnerConfig` 与 `path`、已有 `ROOT` 常量）：

```ts
test('项目级配置分层(0.3.82):projectGet ?? vscodeGet;persistedServer 仍最高', () => {
  const project: Record<string, unknown> = { 'runner.server': 'proj:1', 'runner.timeoutMs': 3000 };
  const vs: Record<string, unknown> = { 'runner.server': 'vs:2', 'runner.protoDir': 'protos' };
  const layered = (k: string) => project[k] ?? vs[k];
  const cfg = resolveRunnerConfig(layered, ROOT);
  assert.equal(cfg.server, 'proj:1'); // 项目文件压过 VS Code 设置
  assert.equal(cfg.timeoutMs, 3000);
  assert.equal(cfg.protoDir, path.join(ROOT, 'protos')); // 项目文件没写的键回退 VS Code 设置
  // 顶栏编辑持久化值 > 项目文件 runner.server
  assert.equal(resolveRunnerConfig(layered, ROOT, 'top:9').server, 'top:9');
});
```

- [ ] **Step 2.2: 跑测试确认通过（纯函数无需改动）**

Run: `node scripts/build.mjs; node --test out/test/runnerConfig.test.js`
Expected: PASS —— `resolveRunnerConfig(get, ...)` 本就是 get 注入式，此测试锁定分层契约，纯函数零改动。

- [ ] **Step 2.3: 改 webviewPanel.ts 包装签名**

`src/runner/webviewPanel.ts:776-788`，把：

```ts
/** 读取 protoUtils.runner.* 全量配置;protoDir 为空 = 工作区根,相对路径相对 workspace folder。
 *  persistedServer(0.3.75):顶栏编辑持久化值,优先于老配置项 runner.server。 */
export function resolveRunnerConfig(persistedServer?: string | null): {
```

改为：

```ts
/** 读取 protoUtils.runner.* 全量配置;protoDir 为空 = 工作区根,相对路径相对 workspace folder。
 *  persistedServer(0.3.75):顶栏编辑持久化值,优先于老配置项 runner.server。
 *  projectGet(0.3.82):项目文件 .proto-utils/settings.json 的 get,压过 VS Code settings(分层在调用方组合)。 */
export function resolveRunnerConfig(
  persistedServer?: string | null,
  projectGet?: (key: string) => unknown,
): {
```

并把函数体内：

```ts
  const resolved = resolveRunnerConfigPure((key) => config.get(key), root, persistedServer);
```

改为：

```ts
  const resolved = resolveRunnerConfigPure(
    (key) => (projectGet ? projectGet(key) : undefined) ?? config.get(key),
    root,
    persistedServer,
  );
```

- [ ] **Step 2.4: 改 extension.ts buildManager 装配**

`src/extension.ts` LazyWorkbench 加第四个构造参数（`constructor` 在 141-146 行）：

```ts
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly scanExcludes: ScanExcludes,
    /** 工作台 proto 加载尘埃落定(成功/部分错误/抛错)时回调:诊断平面借此补一次飘红(0.3.40) */
    private readonly onLoadSettled: () => void,
    /** 项目级配置 get(0.3.82):.proto-utils/settings.json 命中值压过 VS Code settings;无工作区文件时恒 undefined */
    private readonly projectGet: (key: string) => unknown,
  ) {}
```

buildManager 内两处调用点（225、233 行）改为：

```ts
      const c = runner.resolveRunnerConfig(persistedServer, this.projectGet);
```

```ts
      getConfig: () => runner.resolveRunnerConfig(persistedServer, this.projectGet),
```

（activate 里 `new LazyWorkbench(...)` 的调用在 Task 4 一并更新传参；本步先改完 class 定义会有一处临时编译错，Task 4 消除。若要保持每步可编译，可先在本步同步把 61 行改为 `new LazyWorkbench(context, scanExcludes, loadDiagnosticsTrigger.trigger, () => undefined)`，Task 4 再换成真的 projectConfig。）

- [ ] **Step 2.5: typecheck + 全量测试**

Run: `npm run typecheck; npm test`
Expected: typecheck 0 errors；全部测试 PASS。

- [ ] **Step 2.6: Commit**

```powershell
git add src/runner/webviewPanel.ts src/extension.ts src/test/runnerConfig.test.ts
git commit -m "feat: runner config reads project-level overrides via layered get"
```

---

### Task 3: codegen 接入分层 get

**Files:**
- Modify: `src/codegen/command.ts:14-17, 94, 130-131, 178-201`

codegen 无独立单测通道（readConfig 耦合 vscode，vscode 在测试里是 stub），改动为纯参数穿透，靠 typecheck + 现有 emitter 测试兜底。

- [ ] **Step 3.1: registerCodeGenCommand 加参数**

`src/codegen/command.ts:14-17` 改为：

```ts
export function registerCodeGenCommand(
  context: vscode.ExtensionContext,
  frontend: ProtoFrontend,
  /** 项目级配置 get(0.3.82):命中 codeGen.* 键压过 VS Code settings */
  projectGet: (key: string) => unknown,
): void {
```

- [ ] **Step 3.2: readConfig / readPathOptions 改分层**

`src/codegen/command.ts:178-201` 整体替换为（相对键 `cfg.get('enumStyle')` → 根命名空间全键 `'codeGen.enumStyle'`，兜底逻辑原样保留）：

```ts
function readConfig(projectGet: (key: string) => unknown): CodeGenConfig {
  const cfg = vscode.workspace.getConfiguration('protoUtils');
  // 分层(0.3.82):项目文件 .proto-utils/settings.json 命中值压过 VS Code settings
  const get = <T>(key: string, dflt: T): T => {
    const v = projectGet(`codeGen.${key}`);
    return (v !== undefined && v !== null ? (v as T) : cfg.get<T>(key, dflt));
  };
  // int64Style 非法值兜底 'number'(package.json 枚举之外的旧配置)
  const int64StyleRaw = get<string>('int64Style', 'number');
  const int64Style = int64StyleRaw === 'bigint' || int64StyleRaw === 'string' ? int64StyleRaw : 'number';
  return {
    enumStyle: get<'enum' | 'union'>('enumStyle', 'enum'),
    optionalMessageFields: get<boolean>('optionalMessageFields', true),
    optionalScalarFields: get<boolean>('optionalScalarFields', false),
    fieldNaming: get<'camelCase' | 'preserve'>('fieldNaming', 'camelCase'),
    oneofStyle: get<'optional' | 'union'>('oneofStyle', 'optional'),
    importExtension: get<'ts' | 'none'>('importExtension', 'ts'),
    int64Style,
  };
}

function readPathOptions(workspaceRoot: string, projectGet: (key: string) => unknown): OutputPathOptions {
  const cfg = vscode.workspace.getConfiguration('protoUtils.codeGen');
  const pick = <T>(key: string, dflt: T): T => {
    const v = projectGet(`codeGen.${key}`);
    return v !== undefined && v !== null ? (v as T) : cfg.get<T>(key, dflt);
  };
  return {
    workspaceRoot,
    outputDir: pick<string>('outputDir', 'generated'),
    pathMapping: pick<'package' | 'file'>('pathMapping', 'file'),
  };
}
```

- [ ] **Step 3.3: 更新三处调用点**

- `command.ts:94`：`readConfig(), readPathOptions(workspaceRoot)` → `readConfig(projectGet), readPathOptions(workspaceRoot, projectGet)`
- `command.ts:130`：`const config = readConfig();` → `const config = readConfig(projectGet);`
- `command.ts:131`：`const pathOptions = readPathOptions(workspaceRoot);` → `const pathOptions = readPathOptions(workspaceRoot, projectGet);`

- **前置说明**：extension.ts:51 的 `registerCodeGenCommand(context, frontend)` 调用点在 Task 4 一并补第三参（本任务结束时 typecheck 会报该处缺参，属预期；如需保持每步可编译，可临时传 `() => undefined`）。

- [ ] **Step 3.4: Commit（与 Task 4 合并提交亦可）**

```powershell
git add src/codegen/command.ts
git commit -m "feat: codegen config reads project-level overrides"
```

---

### Task 4: extension.ts 装配（实例化、watcher、警告、命令）

**Files:**
- Modify: `src/extension.ts:12-13, 18-23, 51, 61, 63-67, 85 后新增段落`

- [ ] **Step 4.1: import 与实例化**

`src/extension.ts:13` 后加 import：

```ts
import { ProjectConfig } from './projectConfig';
```

activate 开头（19-23 行）改为：

```ts
  const workspaceDirs = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  // 项目级配置(0.3.82):.proto-utils/settings.json 命中键压过 VS Code settings;
  // 激活时读一次,文件 watcher 负责热更新(见下方 settingsWatcher)。
  const projectConfig = workspaceDirs[0] ? new ProjectConfig(workspaceDirs[0]) : null;
  await projectConfig?.reload();
  const projectGet = (key: string): unknown => projectConfig?.get(key);
  const getSetting = (key: string): unknown => projectGet(key) ?? vscode.workspace.getConfiguration('protoUtils').get(key);
  const { protoDir, protoDirExplicit } = resolveRunnerConfigPure(getSetting, workspaceDirs[0]);
```

（21-23 行原有的 `getSetting` 定义被上面替换；`resolveRunnerConfigPure` / `resolveScanExcludes` 两行调用不动，自动吃到分层 get。）

- [ ] **Step 4.2: 传参给 codegen 与 LazyWorkbench**

- `extension.ts:51`：`registerCodeGenCommand(context, frontend);` → `registerCodeGenCommand(context, frontend, projectGet);`
- `extension.ts:61`：`new LazyWorkbench(context, scanExcludes, loadDiagnosticsTrigger.trigger)` → `new LazyWorkbench(context, scanExcludes, loadDiagnosticsTrigger.trigger, projectGet)`（若 Task 2 临时传了 `() => undefined`，此处替换掉）

- [ ] **Step 4.3: settings.json watcher + 去重警告**

插入位置：**配置变更监听块之后**（即 `extension.ts:112` 的 `)` 与 114 行「打开时同样触发」注释之间）——代码引用了 97 行声明的 `configReloadTimer` 和 61 行的 `workbench`，必须排在二者之后，否则 TDZ 报错。新增：

```ts
  // 项目级配置文件热更新(0.3.82):变更 → reload + 去重警告 + 走 0.3.70 的
  // notifyConfigChanged(true)(推 config 纠顶栏显示 + 500ms 防抖重载服务列表)。
  // 与 VS Code settings 同款限制:扫描根/排除集烤在激活时,改 protoDir/excludeDirs 需 reload 窗口。
  if (projectConfig) {
    const warnConfigError = (): void => {
      const err = projectConfig.error;
      if (err && err !== lastWarnedConfigError) {
        lastWarnedConfigError = err;
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Proto Utils: Ignoring .proto-utils/settings.json: {0}', err),
        );
      }
    };
    let lastWarnedConfigError: string | undefined = projectConfig.error;
    warnConfigError(); // 激活时文件已坏也要提示一次
    const settingsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceDirs[0], '.proto-utils/settings.json'),
    );
    const onSettingsChanged = (): void => {
      void projectConfig.reload().then(() => {
        warnConfigError();
        clearTimeout(configReloadTimer);
        configReloadTimer = setTimeout(() => void workbench.notifyConfigChanged(true), 500);
      });
    };
    settingsWatcher.onDidCreate(onSettingsChanged);
    settingsWatcher.onDidChange(onSettingsChanged);
    settingsWatcher.onDidDelete(onSettingsChanged);
    context.subscriptions.push(settingsWatcher);
  }
```

注意：`lastWarnedConfigError` 声明在 `warnConfigError` 函数体之后、首次调用之前，保持上面代码顺序即可（首次调用执行时声明已求值）。

- [ ] **Step 4.4: `createProjectConfig` 命令**

在 openRpcRunner/callMethod 命令注册处（`extension.ts:62-67`）的 `context.subscriptions.push(...)` 里追加第三项：

```ts
    vscode.commands.registerCommand('protoUtils.createProjectConfig', async () => {
      if (!projectConfig) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Proto Utils: No workspace folder open.'));
        return;
      }
      try {
        const file = await projectConfig.ensureFile();
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
      } catch (err) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Proto Utils: Failed to create project config file: {0}', err instanceof Error ? err.message : String(err)),
        );
      }
    }),
```

（`'Proto Utils: No workspace folder open.'` 已在 l10n bundle 中，直接复用。）

- [ ] **Step 4.5: typecheck + 全量测试**

Run: `npm run typecheck; npm test`
Expected: 0 errors，全部 PASS。

- [ ] **Step 4.6: Commit**

```powershell
git add src/extension.ts
git commit -m "feat: wire project config into activation, watcher and create command"
```

---

### Task 5: package.json / nls / l10n 注册

**Files:**
- Modify: `package.json`（activationEvents、commands）
- Modify: `package.nls.json`、`package.nls.zh-cn.json`
- Modify: `l10n/bundle.l10n.zh-cn.json`

- [ ] **Step 5.1: package.json**

activationEvents（20-23 行）追加一行：

```json
  "activationEvents": [
    "onLanguage:proto3",
    "onCommand:protoUtils.openRpcRunner",
    "onCommand:protoUtils.createProjectConfig"
  ],
```

commands 数组（46-59 行）追加（命令经 `contributes.commands` 自动进 Command Palette，无需 menus 条目——与现有三命令一致）：

```json
      {
        "command": "protoUtils.createProjectConfig",
        "title": "%command.createProjectConfig%"
      }
```

- [ ] **Step 5.2: nls 双语标题**

`package.nls.json` `"command.openRpcRunner"` 行后加：

```json
  "command.createProjectConfig": "Proto Utils: Create Project Config File",
```

`package.nls.zh-cn.json` 同位置加：

```json
  "command.createProjectConfig": "Proto Utils: 创建项目配置文件",
```

- [ ] **Step 5.3: l10n bundle**

`l10n/bundle.l10n.zh-cn.json` 末尾（173 行 `"Proto Utils: Failed to open environments file: {0}"` 之后）加两条：

```json
  "Proto Utils: Ignoring .proto-utils/settings.json: {0}": "Proto Utils: 已忽略 .proto-utils/settings.json:{0}",
  "Proto Utils: Failed to create project config file: {0}": "Proto Utils: 创建项目配置文件失败:{0}"
```

- [ ] **Step 5.4: i18n 一致性测试**

Run: `npm test`
Expected: PASS —— `src/test/i18n.test.ts` 校验 l10n/nls 键完整性，若漏键此步会红。

- [ ] **Step 5.5: Commit**

```powershell
git add package.json package.nls.json package.nls.zh-cn.json l10n/bundle.l10n.zh-cn.json
git commit -m "feat: register createProjectConfig command with bilingual titles"
```

---

### Task 6: ADR、README、版本号

**Files:**
- Create: `docs/adr/0014-project-level-settings-file.md`
- Modify: `README.md`、`README.zh-CN.md`
- Modify: `package.json:6`（version）

- [ ] **Step 6.1: ADR-0014（单段落风格，同 ADR-0012）**

创建 `docs/adr/0014-project-level-settings-file.md`：

```markdown
# 项目级配置文件：.proto-utils/settings.json

插件配置此前只走 VS Code Settings，缺少进版本库、团队共享的项目级入口。我们决定新增 `.proto-utils/settings.json`（扁平点分键、不带 `protoUtils.` 前缀，与 `resolveRunnerConfig` 的 get 键名一致），与 sequences.json（ADR-0012）、environments.json（0.3.78）同目录同惯例；实现上**不改任何解析函数**，只把三个消费点的 `get` 换成分层版 `projectConfig.get(key) ?? vscodeGet(key)`。优先级：顶栏地址(workspaceState) > 项目文件 > VS Code 设置 > 默认值。

## Considered Options

- **只用 VS Code 原生机制（.vscode/settings.json 工作区覆盖）**：零新概念，但该目录常被 gitignore、共享与否不可控，且无模板/校验入口，弃。
- **键名白名单（只开放"适合项目级"的子集）**：边界更干净，但要维护名单，用户写了不生效反而困惑，弃——全部键可覆盖，语义统一为"项目文件即团队共识默认值"。

## Consequences

- 项目文件里的键压过个人 VS Code 设置：个人要让位只能删项目文件里的键（团队契约优先，有意为之）。
- 扫描根(protoDir)与排除集(scan.excludeDirs)仍烤在激活时：项目文件改这两项与改 VS Code 设置同款限制——需 reload 窗口；其余键经 watcher 热更新即时生效。
- 文件格式一旦发布即成契约（沿用"只增不改"惯例）；坏 JSON 整文件忽略 + 去重警告，绝不半生效。
- 模板键值 = package.json 默认值：`createProjectConfig` 创建文件本身不改变任何行为。
```

- [ ] **Step 6.2: README 双语补"项目级配置"**

`README.md`：Features 列表 `Environments:` 行后加一条 bullet：

```markdown
- Project-level config: `.proto-utils/settings.json` (commit it to share with your team) overrides any `protoUtils.*` setting — flat dotted keys without the `protoUtils.` prefix; precedence: workbench address bar > project file > VS Code settings > defaults. Create it via **Proto Utils: Create Project Config File**
```

并在 `## Usage` 下新增小节（位置放在 "Editing and Navigation" 之前）：

```markdown
### Project-level Configuration

Run **Proto Utils: Create Project Config File** to generate `.proto-utils/settings.json` with default-valued example keys. Keys are the setting IDs without the `protoUtils.` prefix:

```json
{
  "runner.protoDir": "proto",
  "runner.timeoutMs": 30000,
  "codeGen.outputDir": "src/generated",
  "scan.excludeDirs": ["third_party"]
}
```

The file is meant to be committed — it gives the whole team the same defaults. Keys present in the file override VS Code settings (user and workspace); keys absent fall through. The server address edited in the workbench header still wins over everything. Changes apply live, except `runner.protoDir` / `scan.excludeDirs` which need a window reload (same as VS Code settings).
```

`README.zh-CN.md` 在对应位置加同款内容的中文版：

```markdown
- 项目级配置：`.proto-utils/settings.json`（进版本库、团队共享）可覆盖任意 `protoUtils.*` 设置——扁平点分键、不带 `protoUtils.` 前缀；优先级：工作台顶栏地址 > 项目文件 > VS Code 设置 > 默认值。用命令 **Proto Utils: 创建项目配置文件** 生成
```

```markdown
### 项目级配置

运行命令 **Proto Utils: 创建项目配置文件** 生成 `.proto-utils/settings.json`，模板键值全部等于默认值（创建本身不改变行为）。键名 = 设置项去掉 `protoUtils.` 前缀：

```json
{
  "runner.protoDir": "proto",
  "runner.timeoutMs": 30000,
  "codeGen.outputDir": "src/generated",
  "scan.excludeDirs": ["third_party"]
}
```

该文件用于提交进版本库，给全团队同一份默认值。文件里写了的键压过 VS Code 设置（用户级与工作区级），没写的键正常回退；工作台顶栏编辑的服务器地址仍优先于一切。改动即时生效，`runner.protoDir` / `scan.excludeDirs` 除外——与 VS Code 设置同款限制，需 reload 窗口。
```

（注意：README 里嵌套的 ```json 代码块若与外层围栏冲突，按文件内既有惯例缩进/围栏层级处理。）

- [ ] **Step 6.3: 版本号 0.3.81 → 0.3.82**

`package.json:6`：`"version": "0.3.81"` → `"version": "0.3.82"`。
README/README.zh-CN 若有版本功能标注表（按项目"版本升级与标注惯例"），同步补 0.3.82 行：项目级配置文件 `.proto-utils/settings.json`。

- [ ] **Step 6.4: Commit**

```powershell
git add docs/adr/0014-project-level-settings-file.md README.md README.zh-CN.md package.json
git commit -m "docs: ADR-0014 project-level settings file; README sections; bump 0.3.82"
```

---

### Task 7: 全量验证收尾

- [ ] **Step 7.1: typecheck + 全量测试**

Run: `npm run typecheck; npm test`
Expected: 0 errors；全部测试 PASS（含新增 projectConfig 6 例、runnerConfig 分层 1 例、i18n 键校验）。

- [ ] **Step 7.2: 冒烟清单（手动，F5 扩展开发宿主）**

1. 无 `.proto-utils/settings.json` 的工作区：行为与改动前完全一致（回退链不受影响）。
2. 命令面板跑 "Proto Utils: 创建项目配置文件" → 生成模板并打开；模板里改 `"runner.timeoutMs": 3000`，重开 RPC 工作台发起调用，超时生效。
3. 模板里写 `"runner.protoDir": "proto"` → 提示需 reload 窗口后服务列表换目录（与 VS Code 设置同款限制）。
4. 把文件改成坏 JSON → 弹一次警告"已忽略 .proto-utils/settings.json:…"，再触发变更不重复弹；修复后警告不再出现且配置生效。
5. 顶栏编辑服务器地址 → 压过项目文件里的 `runner.server`。
6. codegen：项目文件写 `"codeGen.outputDir": "gen2"`，跑 Generate All Types → 产物落 `gen2/`。

- [ ] **Step 7.3: 最终提交（如冒烟期间有修补）**

```powershell
git status
git add -A
git commit -m "fix: smoke-test touch-ups for project config"
```
