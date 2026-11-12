# 代码生成重写输入侧到 protobufjs,输出契约冻结

ADR-0002 退役自研 AST 后,Generate TypeScript Types 的 emitter 输入侧重写为消费 protobufjs 反射对象,但输出契约一字不动:五个配置旋钮(enumStyle / optionalMessageFields / optionalScalarFields / fieldNaming / oneofStyle)、interface 风格、import type 依赖图全部保持,老用户升级无感。明确否决 proto-loader-gen-types:它的输出风格(命名空间 + I 前缀双类型)与现有契约不兼容,且调用面走动态反射,用不上它生成的 client 类型。

---

**0.3.89 补记**:冻结契约的边界明确为「原本可编译的产物字节不变」(golden 语料零漂移);原本编译不过的产物按以下规则修正:

- 导出名唯一化:嵌套平铺撞名取父链限定名(Foo.Request → FooRequest),顶层优先保原名,仍撞加数字后缀;camelCase 折叠撞名字段一方回退书写名;TS 保留字与内建遮蔽(Record/Promise/AsyncIterable/Uint8Array)类型名加 `_`。跨文件 import 绑定名恒等于目标文件实际导出名,别名避开本地导出、其他绑定与彼此。
- 内建 WKT(google.protobuf.*)由悬空引用改为按需自包含本地声明(含 Struct/Value 递归闭包),与本地导出或 import 别名撞名时取 GoogleProtobuf 前缀或数字后缀。
- 空 enum 的 union 风格产 never;Record 键非 PropertyKey(bigint/boolean)回退 string。
- 命令层:单文件生成补输出碰撞预检;outputDir 收窄为工作区内相对路径(SPEC story 21 的「任意位置」以此为准);全量生成进可取消进度通知、逐文件失败汇总不中断。
