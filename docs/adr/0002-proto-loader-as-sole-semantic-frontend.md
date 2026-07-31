# proto 语义统一由 proto-loader 提供,自研 parser 退役

合并后扩展内只保留一个 proto 语义前端:`@grpc/proto-loader`(protobufjs)。proto-utils 原有的自研 lexer/parser/AST 整体退役,因为两个语义解析器会对同一文件给出矛盾结论(编辑器说合法、调用面说非法)。已验证的代价:protobufjs 的反射对象不携带源码位置(line 仅用于报错文案和注释归属),因此跳转定义等编辑器功能必须另有位置数据来源,且编辑器内诊断退化为「首个错误即止」,无法像语言服务器那样容错恢复。
