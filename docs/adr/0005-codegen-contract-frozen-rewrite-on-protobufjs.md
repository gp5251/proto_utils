# 代码生成重写输入侧到 protobufjs,输出契约冻结

ADR-0002 退役自研 AST 后,Generate TypeScript Types 的 emitter 输入侧重写为消费 protobufjs 反射对象,但输出契约一字不动:五个配置旋钮(enumStyle / optionalMessageFields / optionalScalarFields / fieldNaming / oneofStyle)、interface 风格、import type 依赖图全部保持,老用户升级无感。明确否决 proto-loader-gen-types:它的输出风格(命名空间 + I 前缀双类型)与现有契约不兼容,且调用面走动态反射,用不上它生成的 client 类型。
