# RPC 工作台亮/暗双主题:固定配色 + 跟随 VSCode 自动切换

背景:工作台 webview 原本只有一套写死在 `media/runner/runner.css :root` 的 GitHub Dark 调色板,亮色 VSCode 主题下白字瞎眼。用户要求增加亮色皮肤并跟随 VSCode 自动更换,且明确:亮色也固定配色、不映射 `--vscode-*` 变量、不加手动设置项、暗色保持现状。

决策:纯 CSS 双主题,零 JS/扩展侧改动。

- `:root` 保留暗色(默认)调色板,字节级不变;新抽 `--accent-ring` / `--warning` / `--warning-bg` / `--btn-bg` / `--btn-hover` / `--btn-border` / `--btn-text` 接管原有 11 处硬编码字面量,暗色取值 = 原字面量,渲染逐像素不变。
- `body.vscode-light, body.vscode-high-contrast-light` 块覆盖全部颜色变量为 GitHub Light 固定配色。这两个 class 由 VSCode 自动注入 webview body 并随主题切换实时更新 —— "跟随皮肤"由平台原生完成,无需 `onDidChangeActiveColorTheme` 监听或 postMessage。
- 暗色主题下半透明的 alpha 底色(`--danger-bg` 等)在亮底下对比不足,亮色侧一律换 GitHub Primer 实体浅底色(`#ffebe9` 等),文字色同步换深色变体。

伴随约束:

- 新增颜色一律走变量,禁写死字面量(已写入 runner.css 文件头注释)。
- 顺手删除死变量 `--accent-hover`、`--success-bg`(声明后从未被引用,删除不改变渲染)。
- 高对比主题归类处理:`vscode-high-contrast-light` 走亮色,`vscode-high-contrast` 落回暗色,不做额外适配。

否决:映射 `--vscode-*` 原生变量(会改变现有暗色观感,且固定配色保证对比度/观感一致,不随用户主题变种漂移);host 侧主题检测 + 消息协议(与平台自动注入的 body class 重复造轮子)。
