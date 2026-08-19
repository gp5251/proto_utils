# JSON 输入放宽为 JSON5:用户输入解析点统一换 JSON5.parse

背景:工作台 JSON 直输编辑器(表单|JSON 双模式)一直用严格 `JSON.parse`,尾逗号、注释、单引号键、裸键名都直接报「JSON 解析失败」。用户要求输入宽松化,指名 json5。

决策:引入 `json5@^2.2.3` 依赖(零传递依赖、自带 .d.ts、CJS+ESM 双入口,esbuild 直接打进现有三个 bundle)。把**解释用户手输 JSON 的全部解析点**从 `JSON.parse` 换成 `JSON5.parse`:

- `src/runner/utils/formMapping.ts`:`validateJsonText` / `applyJsonText`(JSON 编辑器主路径);`formValuesToJson` 里两个 textarea 槽位还原(保证 JSON 标签页展示与请求构建同语法)。
- `src/runner/callHandler.ts`:`_raw` 无 schema 兜底分支。
- `src/runner/utils/formParser.ts`:repeated 数组字符串、TYPE_MESSAGE 字符串槽位。

JSON5 是 JSON 的严格超集:既有合法 JSON 输入行为逐字节不变,错误消息沿用「JSON 解析失败」。proto 语义判定仍归 `@grpc/proto-loader`(ADR-0002),JSON5 只处理用户输入的参数文本,不碰 proto 解析。

伴随约束:

- 每个 bundle 各带一份 json5 实现(extension、runner 懒加载、media formMapping iife),无运行时共享问题;测试 import 同一份 TS 源,与浏览器执行代码一致(ADR-0009)。
- 不换 JSON5.stringify:输出仍用 `JSON.stringify`,生成物保持标准 JSON。

否决:手写「去注释/尾逗号」预处理(注释/字符串边界易错);自研宽松解析器(违背最小依赖,且 json5 是事实标准)。
