import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import protobuf from 'protobufjs';
import { ProtoSchema } from '../runtime/protoFrontend';
import { emit, DEFAULT_CONFIG, CodeGenConfig } from '../codegen/emitter';

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
  assert.ok(out.includes("import type { Address } from './common/address';"));
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
