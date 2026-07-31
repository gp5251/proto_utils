# Proto Utils — VSCode Proto3 插件 Spec

## Problem Statement

开发者在 VSCode 中编辑 `.proto` 文件时缺乏一等公民支持：没有语法高亮（或仅有粗糙的正则着色）、无法跳转到类型定义、从 proto 到 TypeScript 类型的转换依赖外部工具链。对于纯 TS interface/type 生成场景，现有方案（protoc + 插件、buf generate）过重且需要额外安装。

## Solution

一款 VSCode 插件（`proto-utils`），提供：

1. **语法高亮** — TextMate grammar 即时基础着色 + Semantic Tokens 语义增强（区分自定义类型与内置类型）
2. **跳转到定义** — 同文件、跨文件（import 链）、package 命名空间全解析
3. **Code-gen** — 从 proto 生成纯 TS interface/type/enum，7 项用户可配置行为，右键菜单 + 命令面板触发
4. **RPC 工作台** — 编辑器内直接发起 gRPC 调用（一元 + 服务端流），rpc 方法上方 CodeLens 入口（见 docs/adr 0001~0007 的合并决策）

> 依赖说明（2026-07-31 修订，ADR-0002/0004）：编辑面（高亮/跳转/codegen）保持零外部运行时依赖；调用面（RPC 工作台）引入 `@grpc/grpc-js` 与 `@grpc/proto-loader`，经懒加载隔离，首次打开工作台时才载入。原「零外部依赖/内置 proto3 parser」表述随自研 parser 退役废止。

## User Stories

1. As a backend developer, I want proto3 keywords (`syntax`, `message`, `enum`, `service`, `rpc`, `import`, `package`, `option`, `reserved`, `oneof`, `map`, `repeated`, `returns`, `stream`) highlighted when I open a `.proto` file, so that I can read the file structure at a glance.
2. As a backend developer, I want built-in scalar types (`string`, `int32`, `int64`, `uint32`, `uint64`, `sint32`, `sint64`, `fixed32`, `fixed64`, `sfixed32`, `sfixed64`, `bool`, `bytes`, `float`, `double`) visually distinct from custom message type names, so that I can quickly identify domain types.
3. As a backend developer, I want strings, numbers, comments, and boolean literals colored correctly, so that the file is readable without manual parsing.
4. As a backend developer, I want semantic highlighting to kick in after the parser initializes, so that custom type references (including cross-file) get a distinct color even before I interact with the file.
5. As a backend developer, I want to Ctrl+Click a field type name in the same file and jump to its `message`/`enum` definition, so that I can navigate large proto files efficiently.
6. As a backend developer, I want to Ctrl+Click a type defined in another file (via `import`) and jump to that file at the correct line, so that I can navigate multi-file proto schemas.
7. As a backend developer, I want fully-qualified type references (`foo.bar.MyMessage`) resolved through the package namespace, so that I can jump to definitions regardless of how the type is referenced.
8. As a frontend developer, I want to right-click a `.proto` file and select "Generate TypeScript Types" to produce TS interfaces, so that I can use proto-defined contracts in my frontend code without manual transcription.
9. As a frontend developer, I want to trigger code-gen from the command palette (`Ctrl+Shift+P` → "Proto Utils: Generate TypeScript Types"), so that I can generate types without leaving the keyboard.
10. As a developer, I want `message` definitions generated as TypeScript `interface` declarations, so that I get structural typing and easy extension.
11. As a developer, I want `enum` definitions generated as TypeScript `enum` by default, so that I get nominal-like enum behavior with numeric values.
12. As a developer, I want to configure enum generation as union types (`type Status = 'UNKNOWN' | 'ACTIVE'`) instead of TS enums, so that I can prefer literal unions in my codebase.
13. As a developer, I want `snake_case` proto field names converted to `camelCase` in generated TS by default, so that the output follows TypeScript conventions.
14. As a developer, I want to configure field naming to `preserve` (keep `snake_case`), so that I can match existing backend conventions when needed.
15. As a developer, I want non-repeated message-typed fields marked as optional (`?`) by default, so that the generated types reflect proto3's absence semantics.
16. As a developer, I want to configure whether scalar fields are marked optional, so that I can control strictness of the generated types.
17. As a developer, I want `repeated T` fields generated as `T[]`, so that arrays are correctly typed.
18. As a developer, I want `map<K, V>` fields generated as `Record<K, V>`, so that map fields are correctly typed.
19. As a developer, I want `oneof` fields generated as simple optional fields by default, so that the common case stays simple.
20. As a developer, I want to configure `oneof` generation as discriminated unions, so that mutual exclusivity is enforced at the type level when I need it.
21. As a developer, I want the output directory configurable (default `generated/`), so that I can place generated files wherever my project structure requires.
22. As a developer, I want the output file path derived from the proto `package` declaration by default (e.g. `package my.service` → `generated/my/service.ts`), so that namespace structure is preserved.
23. As a developer, I want to configure path mapping to use the proto file path instead of the package, so that I can match my source layout.
24. As a developer, I want cross-file type references in generated TS to produce correct import statements, so that the generated code compiles without manual fixup.
25. As a developer, I want the plugin to have zero external dependencies (no protoc, no buf, no CLI tools), so that it works out of the box on any machine.
26. As a developer, I want the workspace indexed on plugin activation with incremental updates on file change, so that go-to-definition and semantic tokens work across all proto files without manual refresh.

## Implementation Decisions

1. **Editor plane stays dependency-free** — 编辑面不需要 protoc/buf/CLI;调用面的 grpc 依赖懒加载隔离(见上方依赖说明)。

2. **proto-loader 语义前端 + 零语义位置索引层(ADR-0002/0003)** — proto 语义(合法性、类型解析、codegen 输入)统一由 `@grpc/proto-loader`(protobufjs)提供;编辑器的位置数据(go-to-def、语义高亮、CodeLens)来自一个不做语义判断的薄扫描器,两者永不矛盾。原「Single AST, multiple consumers」随自研 parser 退役废止。

3. **Dual-layer syntax highlighting** — A TextMate grammar (`.tmLanguage.json`) provides instant token coloring (keywords, scalars, strings, comments, numbers). A Semantic Tokens Provider layers on top once the parser is ready, distinguishing custom type references from built-in types.

4. **Workspace-wide symbol index** — On activation, scan all `*.proto` files in the workspace, parse them, and build a global symbol table (fully-qualified name → definition location). A `FileSystemWatcher` handles incremental updates on create/change/delete.

5. **Package namespace resolution** — Type references are resolved by: (a) same-file scope, (b) imported file scope, (c) fully-qualified package path. Resolution walks the import graph.

6. **Code-gen is pure emission** — The emitter walks the AST and produces a TypeScript string. No intermediate representation beyond the AST. Configuration is read from VSCode settings at emission time.

7. **Configuration surface** — Seven settings under `protoUtils.codeGen.*`:
   - `outputDir` (string, default `"generated"`)
   - `enumStyle` (`"enum"` | `"union"`, default `"enum"`)
   - `optionalMessageFields` (boolean, default `true`)
   - `optionalScalarFields` (boolean, default `false`)
   - `fieldNaming` (`"camelCase"` | `"preserve"`, default `"camelCase"`)
   - `pathMapping` (`"package"` | `"file"`, default `"package"`)
   - `oneofStyle` (`"optional"` | `"union"`, default `"optional"`)

8. **Trigger mechanisms** — Code-gen is triggered via: (a) right-click context menu on `.proto` files in the editor and explorer, (b) command palette command `protoUtils.generateTypes`.

9. **Architecture: pure VSCode Extension API** — No LSP server. All providers (semantic tokens, definition) are registered in-process. Keeps the extension lightweight and fast to activate.

10. **Proto3 only** — No proto2 support. The parser rejects `syntax = "proto2"` and proto2-only constructs (`required`, `optional` keyword, `extensions`, `extend`).

## Testing Decisions

**What makes a good test here:** Test external behavior at module boundaries — given input text, assert output structure. No mocking of internal state. No testing VSCode API integration (validated manually).

**Seam 1: Parser**
- Input: proto3 source strings of increasing complexity
- Assert: AST shape, token positions, error recovery (malformed input produces partial AST + diagnostics, not a crash)
- Coverage targets: all proto3 constructs (message, enum, oneof, map, repeated, nested messages, services, imports, options, reserved, comments)

**Seam 2: Emitter**
- Input: AST (produced by parser from real proto text) + configuration object
- Assert: exact TypeScript output string for each configuration combination
- Coverage targets: all 7 config toggles, cross-file imports producing correct TS import statements, edge cases (empty message, deeply nested, all field types)

**Not unit-tested:**
- Symbol Index (trivial reduce over ASTs, covered implicitly by parser + emitter tests)
- VSCode providers (semantic tokens, definition) — validated via manual extension host debugging

**Test runner:** Node's built-in `node:test` + `assert`. No framework.

## Out of Scope

- Proto2 support
- Runtime serialization code generation (encode/decode)
- gRPC service client/server stub generation
- Formatting / auto-fix for proto files
- Linting / validation rules beyond parse errors
- Cross-editor support (LSP)
- Watch mode / auto-generate on save
- `google.protobuf` well-known types mapping (Timestamp → Date, etc.) — future enhancement
- Proto file creation scaffolding / snippets

## Further Notes

- The parser must produce token positions accurate enough for go-to-definition (line + character for every type reference and definition name). This is the hardest correctness requirement.
- Error recovery matters: a half-typed proto file should still produce a usable partial AST so that highlighting and navigation degrade gracefully rather than disappearing.
- The TextMate grammar should be written first as it provides immediate value with zero parser dependency.
- Generated files should include a header comment (`// Generated by proto-utils. Do not edit.`) for clarity.
- Cross-file TS imports in generated code must use relative paths computed from the output locations of both the importing and imported proto files.
