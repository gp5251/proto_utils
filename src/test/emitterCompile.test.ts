import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { ProtoFrontend } from '../runtime/protoFrontend';
import { emit, DEFAULT_CONFIG, CodeGenConfig, createTypeResolver } from '../codegen/emitter';

/**
 * 产物可编译性回归(0.3.89):golden 只做字节 diff,从不编译产物——
 * 嵌套撞名/WKT 悬空引用/保留字等 7 类 bug 因此漏网。本文件用 tsc API
 * 在内存里编译 emit 产物,断言零诊断;命名契约同时手写断言,不依赖 golden。
 */

/** 内存 tsc:files 为 虚拟路径→内容,返回诊断列表(空 = 编译通过)。 */
function compileErrors(files: Record<string, string>): string[] {
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    types: [],
  };
  const norm = (p: string): string => p.replace(/\\/g, '/');
  // 虚拟路径经 path.resolve 补齐盘符,与 tsc 在 win32 的路径规范化对齐
  const virtual = new Map(Object.entries(files).map(([k, v]) => [norm(path.resolve(k)), v]));
  const host = ts.createCompilerHost(options);
  // esbuild 打包后 typescript 的 getExecutingFilePath 失真(out/test),默认 lib 路径
  // 须显式指回真实安装位置(测试恒从仓库根运行,与 golden/corpus 的 cwd 约定一致)。
  // 两个都要覆盖:getDefaultLibFileName 定主 lib,getDefaultLibLocation 定
  // lib.es2022.full.d.ts 里 <reference lib="..."> 的展开目录。
  const tsLibDir = path.resolve('node_modules/typescript/lib');
  host.getDefaultLibLocation = () => tsLibDir;
  host.getDefaultLibFileName = () => path.join(tsLibDir, ts.getDefaultLibFileName(options));
  const baseGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, onError, shouldCreate) => {
    const content = virtual.get(norm(name));
    if (content !== undefined) return ts.createSourceFile(name, content, lang, true);
    return baseGet(name, lang, onError, shouldCreate);
  };
  const baseExists = host.fileExists.bind(host);
  host.fileExists = (name) => virtual.has(norm(name)) || baseExists(name);
  const baseRead = host.readFile.bind(host);
  host.readFile = (name) => virtual.get(norm(name)) ?? baseRead(name);
  // 相对 import 的模块解析会先查包含目录是否存在,虚拟目录须放行
  const baseDirExists = host.directoryExists?.bind(host);
  host.directoryExists = (name) => {
    const n = norm(name);
    for (const k of virtual.keys()) if (k.startsWith(n + '/')) return true;
    return baseDirExists ? baseDirExists(name) : ts.sys.directoryExists(name);
  };
  const program = ts.createProgram([...virtual.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file
      ? `${norm(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}`
      : '(global)';
    return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}

/** 真实 ProtoFrontend + 临时目录 fixture:emitFile 走与命令层一致的 resolver 链路。 */
function fixture(t: TestContext, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-codegen-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const schema = new ProtoFrontend([dir]).load();
  const pathOptions = { workspaceRoot: dir, outputDir: 'generated', pathMapping: 'file' as const };
  const emitFile = (rel: string, config?: Partial<CodeGenConfig>): string => {
    const filePath = path.join(dir, rel);
    return emit(schema, filePath, { ...DEFAULT_CONFIG, ...config }, createTypeResolver(schema, filePath, pathOptions));
  };
  return { dir, schema, emitFile };
}

// ── bug 1:google.protobuf 内建类型(WKT)悬空引用 ──────────────────

test('WKT:引用生成自包含本地声明(含 Struct 递归闭包),产物可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
import "google/protobuf/timestamp.proto";
import "google/protobuf/any.proto";
import "google/protobuf/duration.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/struct.proto";
import "google/protobuf/field_mask.proto";
import "google/protobuf/wrappers.proto";
message M {
  google.protobuf.Timestamp ts = 1;
  google.protobuf.Any payload = 2;
  google.protobuf.Duration ttl = 3;
  google.protobuf.Empty nothing = 4;
  google.protobuf.Struct meta = 5;
  google.protobuf.FieldMask mask = 6;
  google.protobuf.StringValue label = 7;
  repeated google.protobuf.Timestamp history = 8;
}
service Svc { rpc Ping(google.protobuf.Empty) returns (google.protobuf.Empty); }
`,
  });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('export interface Timestamp'), 'Timestamp 须有本地声明');
  assert.ok(out.includes('export interface Struct'), 'Struct 须有本地声明');
  assert.ok(out.includes('export interface Value'), 'Struct 递归闭包须含 Value');
  assert.ok(out.includes('export interface ListValue'), 'Struct 递归闭包须含 ListValue');
  assert.ok(out.includes('export enum NullValue'), 'Value.oneof 引用的 NullValue 须随闭包输出');
  assert.ok(!out.includes('import type'), 'WKT 不产生跨文件 import');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('WKT + oneofStyle union:Value/Struct 递归类型产物可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
import "google/protobuf/struct.proto";
import "google/protobuf/timestamp.proto";
message M { google.protobuf.Struct meta = 1; google.protobuf.Timestamp ts = 2; }
`,
  });
  const out = f.emitFile('a.proto', { oneofStyle: 'union', int64Style: 'bigint' });
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('WKT 与本地类型同名:本地保持原名,WKT 取 GoogleProtobuf 前缀(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
import "google/protobuf/timestamp.proto";
message Timestamp { string local = 1; }
message M { Timestamp mine = 1; google.protobuf.Timestamp theirs = 2; }
`,
  });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('export interface Timestamp'), '本地 Timestamp 保持原名');
  assert.ok(out.includes('export interface GoogleProtobufTimestamp'), 'WKT 取前缀别名');
  assert.ok(out.includes('mine?: Timestamp;'), '本地引用不变');
  assert.ok(out.includes('theirs?: GoogleProtobufTimestamp;'), 'WKT 引用走别名');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('WKT 跨文件:两个产物各自自包含,合并编译通过(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
import "google/protobuf/timestamp.proto";
message A { google.protobuf.Timestamp ts = 1; }
`,
    'b.proto': `syntax = "proto3";
import "google/protobuf/timestamp.proto";
import "a.proto";
message B { google.protobuf.Timestamp ts = 1; A a = 2; }
`,
  });
  const outA = f.emitFile('a.proto');
  const outB = f.emitFile('b.proto');
  assert.deepEqual(compileErrors({ '/gen/a.ts': outA, '/gen/b.ts': outB }), []);
});

test('WKT 名避开 import 别名:本地 Timestamp + 别名 GoogleProtobufTimestamp 时 WKT 再让位(0.3.89)', (t) => {
  const f = fixture(t, {
    'googleProtobuf.proto': 'syntax = "proto3";\npackage gp;\nmessage Timestamp { int32 other = 1; }\n',
    'a.proto': `syntax = "proto3";
import "google/protobuf/timestamp.proto";
import "googleProtobuf.proto";
message Timestamp { string local = 1; }
message M { Timestamp mine = 1; google.protobuf.Timestamp theirs = 2; gp.Timestamp imported = 3; }
`,
  });
  const outA = f.emitFile('a.proto');
  const outG = f.emitFile('googleProtobuf.proto');
  assert.ok(outA.includes('Timestamp as GoogleProtobufTimestamp'), '跨文件 Timestamp 取路径别名');
  assert.ok(outA.includes('export interface GoogleProtobufTimestamp2'), 'WKT 避开别名取数字后缀');
  assert.ok(outA.includes('theirs?: GoogleProtobufTimestamp2;'), 'WKT 引用一致');
  assert.deepEqual(compileErrors({ '/gen/a.ts': outA, '/gen/googleProtobuf.ts': outG }), []);
});

// ── bug 2:嵌套类型平铺撞名 ──────────────────────────────────────

test('嵌套同名(不同父):限定名 FooRequest/BarRequest,引用正确,可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message Foo { message Request { string id = 1; } Request req = 1; }
message Bar { message Request { int32 id = 1; } Request req = 1; }
`,
  });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('export interface FooRequest'), 'Foo.Request → FooRequest');
  assert.ok(out.includes('export interface BarRequest'), 'Bar.Request → BarRequest');
  assert.ok(out.includes('req?: FooRequest;'), 'Foo 内引用走限定名');
  assert.ok(out.includes('req?: BarRequest;'), 'Bar 内引用走限定名');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('嵌套与顶层同名:顶层保持原名,嵌套取限定名(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message Inner { string a = 1; }
message Outer { message Inner { string b = 1; } Inner inner = 1; }
`,
  });
  const out = f.emitFile('a.proto');
  assert.equal((out.match(/export interface Inner \{/g) ?? []).length, 1, '顶层 Inner 唯一');
  assert.ok(out.includes('export interface OuterInner'), '嵌套 → OuterInner');
  assert.ok(out.includes('inner?: OuterInner;'), '引用走限定名');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('嵌套 enum 与嵌套 message 同名:各自限定,可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message A { enum X { V = 0; } }
message B { message X { string s = 1; } }
`,
  });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('export enum AX'), 'A.X → AX');
  assert.ok(out.includes('export interface BX'), 'B.X → BX');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('深层嵌套撞名:整条父链拼接(ABC / DC)(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message A { message B { message C { string x = 1; } } }
message D { message C { string y = 1; } }
`,
  });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('export interface ABC'), 'A.B.C → ABC');
  assert.ok(out.includes('export interface DC'), 'D.C → DC');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('限定名仍被占用:确定性数字后缀(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message FooRequest { string top = 1; }
message Foo { message Request { string id = 1; } }
message Bar { message Request { int32 id = 1; } }
`,
  });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('export interface FooRequest2'), 'Foo.Request 让位顶层后取 FooRequest2');
  assert.ok(out.includes('export interface BarRequest'), 'Bar.Request → BarRequest');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('跨文件引用被改名的嵌套类型:import 用目标文件导出名(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message Foo { message Request { string id = 1; } }
message Bar { message Request { int32 id = 1; } }
`,
    'b.proto': `syntax = "proto3";
import "a.proto";
message Holder { Foo.Request r1 = 1; Bar.Request r2 = 2; }
`,
  });
  const outA = f.emitFile('a.proto');
  const outB = f.emitFile('b.proto');
  // 同一目标文件的多个绑定合并为一条 import(既有分组契约),按绑定名排序
  assert.ok(outB.includes("import type { BarRequest, FooRequest } from './a.ts';"), 'import 绑定名 = 目标导出名');
  assert.ok(outB.includes('r1?: FooRequest;'), '引用与 import 一致');
  assert.ok(outB.includes('r2?: BarRequest;'), '引用与 import 一致');
  assert.deepEqual(compileErrors({ '/gen/a.ts': outA, '/gen/b.ts': outB }), []);
});

// ── bug 3:camelCase 折叠撞名 ────────────────────────────────────

test('camelCase 撞名:foo_bar 与 fooBar 两字段都保留,可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message M { string foo_bar = 1; string fooBar = 2; }
`,
  });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('fooBar: string;'), '书写名即 camelCase 的字段保持 camelCase');
  assert.ok(out.includes('foo_bar: string;'), '撞名另一方回退原始名');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('camelCase 撞名在 oneof union 风格下同样消歧(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message M { oneof v { string foo_bar = 1; string fooBar = 2; } }
`,
  });
  const out = f.emitFile('a.proto', { oneofStyle: 'union' });
  assert.ok(out.includes('foo_bar: string'), '变体含回退名');
  assert.ok(out.includes('fooBar: string'), '变体含 camelCase 名');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

// ── bug 4:map<int64> + bigint 键 ────────────────────────────────

test('map<int64, V> + int64Style bigint:键回退 string,可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message M { map<int64, string> labels = 1; }
`,
  });
  const out = f.emitFile('a.proto', { int64Style: 'bigint' });
  assert.ok(out.includes('labels: Record<string, string>;'), 'bigint 不能作 Record 键,回退 string');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('map<bool, V>:键回退 string(boolean 不是 PropertyKey),可编译(0.3.89)', (t) => {
  const f = fixture(t, { 'a.proto': 'syntax = "proto3";\nmessage M { map<bool, string> flags = 1; }\n' });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('flags: Record<string, string>;'), 'bool 键回退 string');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

// ── bug 5:import 别名碰撞 ───────────────────────────────────────

test('别名碰撞:foo/bar.proto 与 fooBar.proto 同形别名须消歧,可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'foo/bar.proto': `syntax = "proto3";
package foo;
message Status { int32 x = 1; }
`,
    'fooBar.proto': `syntax = "proto3";
package foobar;
message Status { int32 y = 1; }
`,
    'main.proto': `syntax = "proto3";
import "foo/bar.proto";
import "fooBar.proto";
message FooBarStatus { string z = 1; }
message Holder { foo.Status a = 1; foobar.Status b = 2; }
`,
  });
  const outMain = f.emitFile('main.proto');
  const outBar = f.emitFile('foo/bar.proto');
  const outFooBar = f.emitFile('fooBar.proto');
  const aliasMatches = [...outMain.matchAll(/Status as (\w+)/g)].map((m) => m[1]);
  assert.equal(aliasMatches.length, 2, '两条 import 都取别名');
  assert.equal(new Set(aliasMatches).size, 2, '别名不得同名');
  assert.ok(!aliasMatches.includes('FooBarStatus'), '别名不得与本地类型同名');
  assert.deepEqual(
    compileErrors({ '/gen/main.ts': outMain, '/gen/foo/bar.ts': outBar, '/gen/fooBar.ts': outFooBar }),
    [],
  );
});

// ── bug 6:空 enum ───────────────────────────────────────────────

test('空 enum:union 风格产 never,enum 风格产空 enum,均可编译(0.3.89)', (t) => {
  const f = fixture(t, { 'a.proto': 'syntax = "proto3";\nenum E {}' });
  const union = f.emitFile('a.proto', { enumStyle: 'union' });
  assert.ok(union.includes('export type E = never;'), '无成员 union 必须是 never');
  assert.deepEqual(compileErrors({ '/gen/a.ts': union }), []);
  const asEnum = f.emitFile('a.proto');
  assert.deepEqual(compileErrors({ '/gen/a.ts': asEnum }), []);
});

// ── bug 7:TS 保留字 / 内建工具类型遮蔽 ──────────────────────────

test('保留字与内建遮蔽类型名加 _ 后缀:default/Record/Promise/class,可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message default { string x = 1; }
message Record { string y = 1; }
message Promise { string z = 1; }
enum class { A = 0; }
message M {
  map<string, int32> m = 1;
  default d = 2;
  Record r = 3;
  class c = 4;
}
service Svc { rpc Go(M) returns (M); }
`,
  });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('export interface default_'), 'default → default_');
  assert.ok(out.includes('export interface Record_'), 'Record → Record_(避免遮蔽 Record<K,V>)');
  assert.ok(out.includes('export interface Promise_'), 'Promise → Promise_(避免遮蔽 service 返回类型)');
  assert.ok(out.includes('export enum class_'), 'class → class_');
  assert.ok(out.includes('d?: default_;'), '引用走消毒名');
  assert.ok(out.includes('r?: Record_;'), '引用走消毒名');
  assert.ok(out.includes('c?: class_;'), '枚举引用走消毒名');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

test('保留字表完整:new/typeof/in/bigint 等全部加 _ 后缀,可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message new { string x = 1; }
message typeof { string y = 1; }
message bigint { string z = 1; }
enum in { A = 0; }
message M { new n = 1; typeof t = 2; bigint b = 3; in i = 4; }
`,
  });
  const out = f.emitFile('a.proto');
  assert.ok(out.includes('export interface new_'), 'new → new_');
  assert.ok(out.includes('export interface typeof_'), 'typeof → typeof_');
  assert.ok(out.includes('export interface bigint_'), 'bigint → bigint_');
  assert.ok(out.includes('export enum in_'), 'in → in_');
  assert.ok(out.includes('n?: new_;'), '引用走消毒名');
  assert.deepEqual(compileErrors({ '/gen/a.ts': out }), []);
});

// ── 回归:既有契约产物必须仍然可编译 ─────────────────────────────

test('回归:service 四形态/oneof union/proto3 optional/map/enum/跨文件 import 可编译(0.3.89)', (t) => {
  const f = fixture(t, {
    'common.proto': `syntax = "proto3";
package common;
enum Kind { UNKNOWN = 0; OK = 1; }
message Address { string street = 1; }
`,
    'a.proto': `syntax = "proto3";
import "common.proto";
message Req {
  string id = 1;
  optional int32 count = 2;
  map<string, int64> limits = 3;
  repeated string tags = 4;
  common.Address addr = 5;
  oneof value { string error = 6; int32 n = 7; }
}
message Resp { string id = 1; common.Kind kind = 2; }
service Svc {
  rpc Unary(Req) returns (Resp);
  rpc Watch(Req) returns (stream Resp);
  rpc Upload(stream Req) returns (Resp);
  rpc Chat(stream Req) returns (stream Resp);
}
`,
  });
  const outA = f.emitFile('a.proto', { oneofStyle: 'union' });
  const outCommon = f.emitFile('common.proto');
  assert.deepEqual(compileErrors({ '/gen/a.ts': outA, '/gen/common.ts': outCommon }), []);
});

test('确定性:同一 schema 两次 emit 输出逐字节一致(0.3.89)', (t) => {
  const f = fixture(t, {
    'a.proto': `syntax = "proto3";
message Foo { message Request { string id = 1; } Request req = 1; }
message Bar { message Request { int32 id = 1; } Request req = 1; }
`,
  });
  assert.equal(f.emitFile('a.proto'), f.emitFile('a.proto'));
});