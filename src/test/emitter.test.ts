import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import protobuf from 'protobufjs';
import { ProtoSchema } from '../runtime/protoFrontend';
import { emit, DEFAULT_CONFIG, CodeGenConfig, hasEmittableTypes, createOutputPathResolver, createTypeResolver } from '../codegen/emitter';

const TEST_FILE = path.resolve('test.proto');

/** 用 protobufjs 直接解析内联 proto 构造 ProtoSchema(declarations 归属逻辑对齐 ProtoFrontend)。 */
function schemaFromSource(source: string, filePath: string = TEST_FILE, foreign?: ReadonlyMap<string, string>): ProtoSchema {
  const root = new protobuf.Root();
  protobuf.parse(source, root, { keepCase: true });
  root.resolveAll();
  const declarations = new Map<string, string>();
  const visit = (ns: protobuf.NamespaceBase): void => {
    for (const obj of ns.nestedArray) {
      if (
        obj instanceof protobuf.Type ||
        obj instanceof protobuf.Enum ||
        obj instanceof protobuf.Service
      ) {
        const fqn = obj.fullName.replace(/^\./, '');
        declarations.set(fqn, foreign?.get(fqn) ?? filePath);
      }
      if (obj instanceof protobuf.Namespace) visit(obj);
    }
  };
  visit(root);
  return { root, declarations, files: [filePath] };
}

function generate(proto: string, config?: Partial<CodeGenConfig>): string {
  return emit(schemaFromSource(proto), TEST_FILE, { ...DEFAULT_CONFIG, ...config });
}

test('hasEmittableTypes:纯 import 聚合文件无产物,含 message/enum/service 的文件有产物', () => {
  const importsOnly = schemaFromSource(`
    syntax = "proto3";
    package a.v1;
  `);
  assert.equal(hasEmittableTypes(importsOnly, TEST_FILE), false);

  const svcOnly = schemaFromSource(`
    syntax = "proto3";
    package a.v1;
    service Empty {}
  `);
  assert.equal(hasEmittableTypes(svcOnly, TEST_FILE), true);

  const withDefs = schemaFromSource(`
    syntax = "proto3";
    package a.v1;
    message Req { string id = 1; }
    service Svc { rpc Ping(Req) returns (Req); }
  `);
  assert.equal(hasEmittableTypes(withDefs, TEST_FILE), true);
});

test('service → 客户端调用接口:unary/server-stream/client-stream/bidi 四种形态', () => {
  const out = generate(`
    syntax = "proto3";
    package a.v1;
    message Req { string id = 1; }
    message Resp { string id = 1; }
    service Svc {
      rpc Unary(Req) returns (Resp);
      rpc Watch(Req) returns (stream Resp);
      rpc Upload(stream Req) returns (Resp);
      rpc Chat(stream Req) returns (stream Resp);
    }
  `);
  assert.ok(out.includes('export interface SvcClient {'));
  assert.ok(out.includes('  Unary(request: Req): Promise<Resp>;'));
  assert.ok(out.includes('  Watch(request: Req): AsyncIterable<Resp>;'));
  assert.ok(out.includes('  Upload(request: AsyncIterable<Req>): Promise<Resp>;'));
  assert.ok(out.includes('  Chat(request: AsyncIterable<Req>): AsyncIterable<Resp>;'));
});

test('service 跨文件 req/res 经 resolve 生成 import', () => {
  const schema = schemaFromSource(`
    syntax = "proto3";
    message Local { string id = 1; }
    message Ext { string id = 1; }
    service Svc { rpc Go(Local) returns (Ext); }
  `, TEST_FILE, new Map([['Ext', path.resolve('common/ext.proto')]]));
  const resolver = (typeName: string) => typeName === 'Ext' ? 'common/ext.proto' : null;
  const out = emit(schema, TEST_FILE, DEFAULT_CONFIG, resolver);
  assert.ok(out.includes("import type { Ext } from './common/ext.ts';"));
  assert.ok(out.includes('  Go(request: Local): Promise<Ext>;'));
});

test('跨模块同名 import 冲突 → 双方按路径段取确定性别名', () => {
  const schema = schemaFromSource(`
    syntax = "proto3";
    message Net { message Status { int32 code = 1; } }
    message Project { message Status { int32 code = 1; } }
    message Holder {
      Net.Status a = 1;
      Project.Status b = 2;
    }
  `, TEST_FILE, new Map([
    ['Net.Status', path.resolve('net/global/v1.proto')],
    ['Project.Status', path.resolve('project/global/v1.proto')],
  ]));
  const resolver = (typeName: string) =>
    typeName === 'Net.Status' ? 'net/global/v1.proto' : typeName === 'Project.Status' ? 'project/global/v1.proto' : null;
  const out = emit(schema, TEST_FILE, DEFAULT_CONFIG, resolver);
  assert.ok(out.includes("import type { Status as NetGlobalV1Status } from './net/global/v1.ts';"));
  assert.ok(out.includes("import type { Status as ProjectGlobalV1Status } from './project/global/v1.ts';"));
  assert.ok(out.includes('  a?: NetGlobalV1Status;'));
  assert.ok(out.includes('  b?: ProjectGlobalV1Status;'));
});

test('import 与本地类型同名 → import 取别名,本地保持原名', () => {
  const schema = schemaFromSource(`
    syntax = "proto3";
    message Status { int32 code = 1; }
    message Wrap { message Status { int32 code = 1; } }
    message Holder {
      Status local = 1;
      Wrap.Status remote = 2;
    }
  `, TEST_FILE, new Map([['Wrap.Status', path.resolve('other/v1.proto')]]));
  const resolver = (typeName: string) => typeName === 'Wrap.Status' ? 'other/v1.proto' : null;
  const out = emit(schema, TEST_FILE, DEFAULT_CONFIG, resolver);
  assert.ok(out.includes("import type { Status as OtherV1Status } from './other/v1.ts';"));
  assert.ok(out.includes('  local?: Status;'));
  assert.ok(out.includes('  remote?: OtherV1Status;'));
});

test("pathMapping 'file' → 相对 proto 公共根映射:平级平铺,子目录保留,跨文件 import 为 './sibling'", () => {
  const root = path.resolve('.');
  const common = path.join(root, 'src', 'vs', 'platform', 'autoshop', 'common');
  const fileA = path.join(common, 'a.proto');
  const fileB = path.join(common, 'b.proto');
  const nested = path.join(common, 'sub', 'c.proto');
  const schema = schemaFromSource(`
    syntax = "proto3";
    message Local { string id = 1; }
    message Ext { string id = 1; }
    message Holder { Local l = 1; Ext e = 2; }
  `, fileA, new Map([['Ext', fileB]]));
  schema.files.push(fileB, nested);

  const pathOptions = { workspaceRoot: root, outputDir: 'generated', pathMapping: 'file' as const };
  const outPathOf = createOutputPathResolver(schema, pathOptions);
  // 全部 proto 平级于 common/ → 平铺;common/sub/c.proto → 保留子目录
  assert.equal(outPathOf(fileA), path.join(root, 'generated', 'a.ts'));
  assert.equal(outPathOf(nested), path.join(root, 'generated', 'sub', 'c.ts'));
  const out = emit(schema, fileA, DEFAULT_CONFIG, createTypeResolver(schema, fileA, pathOptions));
  assert.ok(out.includes("import type { Ext } from './b.ts';"));
});

test("pathMapping 'package' → 按 package 语句映射目录", () => {
  const root = path.resolve('.');
  const file = path.join(root, 'protos', 'foo.proto');
  const schema = schemaFromSource(`
    syntax = "proto3";
    package my.deep.v2;
    message M { string id = 1; }
  `, file);
  const out = createOutputPathResolver(schema, { workspaceRoot: root, outputDir: 'generated', pathMapping: 'package' })(file);
  assert.equal(out, path.join(root, 'generated', 'my', 'deep', 'v2.ts'));
});

test("importExtension 'none' → import 路径不带 .ts", () => {
  const schema = schemaFromSource(`
    syntax = "proto3";
    message Local { string id = 1; }
    message Ext { string id = 1; }
    message Holder { Local l = 1; Ext e = 2; }
  `, TEST_FILE, new Map([['Ext', path.resolve('common/ext.proto')]]));
  const resolver = (typeName: string) => typeName === 'Ext' ? 'common/ext.proto' : null;
  const out = emit(schema, TEST_FILE, { ...DEFAULT_CONFIG, importExtension: 'none' }, resolver);
  assert.ok(out.includes("import type { Ext } from './common/ext';"));
});

test('basic message → interface with camelCase fields', () => {
  const out = generate(`
    syntax = "proto3";
    message User {
      string user_name = 1;
      int32 user_age = 2;
      bool is_active = 3;
    }
  `);
  assert.ok(out.includes('export interface User {'));
  assert.ok(out.includes('  userName: string;'));
  assert.ok(out.includes('  userAge: number;'));
  assert.ok(out.includes('  isActive: boolean;'));
});

test('fieldNaming preserve keeps snake_case', () => {
  const out = generate(`
    syntax = "proto3";
    message User {
      string user_name = 1;
    }
  `, { fieldNaming: 'preserve' });
  assert.ok(out.includes('  user_name: string;'));
});

test('message field is optional by default', () => {
  const out = generate(`
    syntax = "proto3";
    message Order {
      Address shipping = 1;
    }
    message Address {
      string street = 1;
    }
  `);
  assert.ok(out.includes('  shipping?: Address;'));
});

test('optionalMessageFields false removes ?', () => {
  const out = generate(`
    syntax = "proto3";
    message Order {
      Address shipping = 1;
    }
    message Address {
      string street = 1;
    }
  `, { optionalMessageFields: false });
  assert.ok(out.includes('  shipping: Address;'));
});

test('optionalScalarFields true adds ? to scalars', () => {
  const out = generate(`
    syntax = "proto3";
    message Foo {
      string name = 1;
    }
  `, { optionalScalarFields: true });
  assert.ok(out.includes('  name?: string;'));
});

test('repeated field → T[]', () => {
  const out = generate(`
    syntax = "proto3";
    message Foo {
      repeated string tags = 1;
      repeated int32 ids = 2;
    }
  `);
  assert.ok(out.includes('  tags: string[];'));
  assert.ok(out.includes('  ids: number[];'));
});

test('map field → Record<K, V>', () => {
  const out = generate(`
    syntax = "proto3";
    message Foo {
      map<string, int32> limits = 1;
    }
  `);
  assert.ok(out.includes('  limits: Record<string, number>;'));
});

test('enum style: TS enum (default)', () => {
  const out = generate(`
    syntax = "proto3";
    enum Status {
      UNKNOWN = 0;
      ACTIVE = 1;
      INACTIVE = 2;
    }
  `);
  assert.ok(out.includes('export enum Status {'));
  assert.ok(out.includes('  UNKNOWN = 0,'));
  assert.ok(out.includes('  ACTIVE = 1,'));
  assert.ok(out.includes('  INACTIVE = 2,'));
});

test('enum style: union', () => {
  const out = generate(`
    syntax = "proto3";
    enum Status {
      UNKNOWN = 0;
      ACTIVE = 1;
    }
  `, { enumStyle: 'union' });
  assert.ok(out.includes("export type Status = 'UNKNOWN' | 'ACTIVE';"));
});

test('oneof style: optional (default)', () => {
  const out = generate(`
    syntax = "proto3";
    message Result {
      string id = 1;
      oneof value {
        string error = 2;
        int32 count = 3;
      }
    }
  `);
  assert.ok(out.includes('export interface Result {'));
  assert.ok(out.includes('  error?: string;'));
  assert.ok(out.includes('  count?: number;'));
});

test('oneof style: union', () => {
  const out = generate(`
    syntax = "proto3";
    message Result {
      oneof value {
        string error = 1;
        int32 count = 2;
      }
    }
  `, { oneofStyle: 'union' });
  assert.ok(out.includes('export type Result ='));
  assert.ok(out.includes('error: string'));
  assert.ok(out.includes('count?: never'));
});

test('nested message and enum', () => {
  const out = generate(`
    syntax = "proto3";
    message Outer {
      message Inner {
        string id = 1;
      }
      enum Kind {
        A = 0;
        B = 1;
      }
      Inner inner = 1;
      Kind kind = 2;
    }
  `);
  assert.ok(out.includes('export interface Inner {'));
  assert.ok(out.includes('export enum Kind {'));
  assert.ok(out.includes('export interface Outer {'));
});

test('bytes maps to Uint8Array', () => {
  const out = generate(`
    syntax = "proto3";
    message Foo {
      bytes data = 1;
    }
  `);
  assert.ok(out.includes('  data: Uint8Array;'));
});

test('header comment present', () => {
  const out = generate(`
    syntax = "proto3";
    message Foo {
      string x = 1;
    }
  `);
  assert.ok(out.startsWith('// Generated by proto-utils. Do not edit.'));
});

test('cross-file import generation', () => {
  // Address 声明在另一个文件 → 走 import;Order 留在本文件
  const schema = schemaFromSource(`
    syntax = "proto3";
    message Order {
      Address shipping = 1;
    }
    message Address {
      string street = 1;
    }
  `, TEST_FILE, new Map([['Address', path.resolve('common/address.proto')]]));
  const resolver = (typeName: string) => typeName === 'Address' ? 'common/address.proto' : null;
  const out = emit(schema, TEST_FILE, DEFAULT_CONFIG, resolver);
  assert.ok(out.includes("import type { Address } from './common/address.ts';"));
  assert.ok(out.includes('  shipping?: Address;'));
});

test('empty message', () => {
  const out = generate(`
    syntax = "proto3";
    message Empty {}
  `);
  assert.ok(out.includes('export interface Empty {'));
  assert.ok(out.includes('}'));
});

// proto3 optional = 显式 presence:恒渲染 `?`,不受 optionalScalarFields 旋钮影响,
// 且 protobufjs 的合成 oneof `_name` 不得走 oneof 渲染分支(独立手写断言,非 golden 照抄)。
test('proto3 optional always renders ? regardless of knobs', () => {
  const proto = `
    syntax = "proto3";
    message Foo {
      optional string name = 1;
      optional int32 count = 2;
      string plain = 3;
    }
  `;
  const out = generate(proto);
  assert.ok(out.includes('export interface Foo {'));
  assert.ok(out.includes('  name?: string;'));
  assert.ok(out.includes('  count?: number;'));
  assert.ok(out.includes('  plain: string;'));
  // 合成 oneof 不泄漏:不变 union、不多出 _name 成员
  assert.ok(!out.includes('_name'));
  assert.ok(!out.includes('never'));

  const preserved = generate(proto, { fieldNaming: 'preserve', optionalScalarFields: false });
  assert.ok(preserved.includes('  name?: string;'));
  assert.ok(preserved.includes('  plain: string;'));
});

// int64Style 三态:64 位整数(int64/uint64/sint64/fixed64/sfixed64)按旋钮映射,
// 普通字段、repeated、map 值、oneof(optional 与 union 两种风格)共用同一条标量查找路径。
test("int64Style 'number'(默认)→ 64 位整数映射 number", () => {
  const out = generate(`
    syntax = "proto3";
    message Foo {
      int64 id = 1;
      uint64 total = 2;
      repeated sint64 deltas = 3;
      map<string, fixed64> points = 4;
    }
  `);
  assert.ok(out.includes('  id: number;'));
  assert.ok(out.includes('  total: number;'));
  assert.ok(out.includes('  deltas: number[];'));
  assert.ok(out.includes('  points: Record<string, number>;'));
});

test("int64Style 'bigint' → 64 位整数映射 bigint,32 位不受影响", () => {
  const out = generate(`
    syntax = "proto3";
    message Foo {
      int64 id = 1;
      int32 seq = 2;
      repeated sfixed64 samples = 3;
      map<string, int64> counts = 4;
    }
  `, { int64Style: 'bigint' });
  assert.ok(out.includes('  id: bigint;'));
  assert.ok(out.includes('  seq: number;'));
  assert.ok(out.includes('  samples: bigint[];'));
  assert.ok(out.includes('  counts: Record<string, bigint>;'));
});

test("int64Style 'string' → 64 位整数映射 string", () => {
  const out = generate(`
    syntax = "proto3";
    message Foo {
      int64 id = 1;
      repeated uint64 totals = 2;
      map<string, sint64> offsets = 3;
    }
  `, { int64Style: 'string' });
  assert.ok(out.includes('  id: string;'));
  assert.ok(out.includes('  totals: string[];'));
  assert.ok(out.includes('  offsets: Record<string, string>;'));
});

test('int64Style 对 oneof 内 64 位整数字段同样生效(optional 与 union 两种风格)', () => {
  const proto = `
    syntax = "proto3";
    message Foo {
      oneof payload {
        int64 big_id = 1;
        string name = 2;
      }
    }
  `;
  const optional = generate(proto, { int64Style: 'bigint' });
  assert.ok(optional.includes('  bigId?: bigint;'));
  assert.ok(optional.includes('  name?: string;'));

  const union = generate(proto, { int64Style: 'string', oneofStyle: 'union' });
  assert.ok(union.includes('{ bigId: string; name?: never }'));
  assert.ok(union.includes('{ name: string; bigId?: never }'));
});

// 回归:原型链上的名字(toString/constructor 等)是合法 message 名,
// 标量判定必须 own-property,否则被误映射成 number/bigint(string/undefined)
test('名为 toString/constructor 的 message 不被误判为标量', () => {
  const out = generate(`
    syntax = "proto3";
    message toString { int64 id = 1; }
    message Holder {
      toString inner = 1;
      repeated toString items = 2;
    }
  `);
  assert.ok(out.includes('export interface toString {'));
  assert.ok(out.includes('  inner?: toString;'));
  assert.ok(out.includes('  items: toString[];'));
});
