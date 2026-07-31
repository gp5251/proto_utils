# Web 页面替换 CLI — 实现计划

> **Goal:** 用 Express + EJS Web 页面替换 CLI 模式，不复用交互式/命令行模块。

**Architecture:** Express 服务启动时加载 proto、缓存 service/method 列表，两个页面：首页（服务方法列表）和调用页（填参调接口看结果）。

**Tech Stack:** Express, EJS, 复用现有 core 模块

---

### Task 1: 添加依赖 + 更新配置

- npm install express ejs @types/express
- rpc.config.json 加 `"port": 3000`
- 提交

### Task 2: 创建 EJS 模板

- `views/layout.ejs` — 公共 HTML 骨架，导航
- `views/home.ejs` — 服务方法列表，按 service 分组
- `views/call.ejs` — JSON 编辑框 + 发送按钮 + 结果展示
- 提交

### Task 3: 创建路由

- `src/routes/home.ts` — GET /: 读 proto 列表，渲染首页
- `src/routes/call.ts` — GET /call/:service/:method: 展示调用页；POST /api/call: 执行 gRPC 调用，返回 JSON
- 提交

### Task 4: 创建 server.ts + 更新入口

- `src/server.ts` — Express 配置，挂载路由
- `src/index.ts` — 替换为启动 server
- 删除 `src/cli/` 目录
- 提交

### Task 5: 验证

- npm run build
- npm run test
- 启动 server，浏览器验证
- 提交
