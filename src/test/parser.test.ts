import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../parser/parser';

test('parses syntax declaration', () => {
  const file = parse('syntax = "proto3";');
  assert.equal(file.syntax, 'proto3');
  assert.equal(file.diagnostics.length, 0);
});

test('parses leading-dot fully-qualified type in field', () => {
  const file = parse(`
    syntax = "proto3";
    message Foo {
      .other.pkg.Bar bar = 1;
    }
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  const f = msg.fields[0];
  if (f.kind !== 'field') return;
  assert.equal(f.type.name, '.other.pkg.Bar');
  assert.equal(f.name.name, 'bar');
  assert.equal(file.diagnostics.length, 0);
});

test('parses leading-dot type in rpc', () => {
  const file = parse(`
    syntax = "proto3";
    service Svc {
      rpc Get (.pkg.Req) returns (.pkg.Resp);
    }
  `);
  const svc = file.definitions[0];
  if (svc.kind !== 'service') return;
  assert.equal(svc.rpcs[0].inputType.name, '.pkg.Req');
  assert.equal(svc.rpcs[0].outputType.name, '.pkg.Resp');
  assert.equal(file.diagnostics.length, 0);
});

test('parses leading-dot type in oneof', () => {
  const file = parse(`
    syntax = "proto3";
    message Foo {
      oneof v {
        .pkg.A a = 1;
        int32 b = 2;
      }
    }
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  const f = msg.oneofs[0].fields[0];
  assert.equal(f.type.name, '.pkg.A');
  assert.equal(file.diagnostics.length, 0);
});

test('parses leading-dot type in map value', () => {
  const file = parse(`
    syntax = "proto3";
    message Foo {
      map<string, .pkg.Bar> m = 1;
    }
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  const f = msg.fields[0];
  if (f.kind !== 'map') return;
  assert.equal(f.valueType.name, '.pkg.Bar');
  assert.equal(file.diagnostics.length, 0);
});

test('parses package', () => {
  const file = parse('syntax = "proto3";\npackage my.service;');
  assert.equal(file.package?.name, 'my.service');
  assert.equal(file.package?.range.start.line, 1);
});

test('parses imports', () => {
  const file = parse(`
    syntax = "proto3";
    import "other.proto";
    import public "shared.proto";
  `);
  assert.equal(file.imports.length, 2);
  assert.equal(file.imports[0].path, 'other.proto');
  assert.equal(file.imports[0].modifier, null);
  assert.equal(file.imports[1].path, 'shared.proto');
  assert.equal(file.imports[1].modifier, 'public');
});

test('parses simple message with scalar fields', () => {
  const file = parse(`
    syntax = "proto3";
    message User {
      string name = 1;
      int32 age = 2;
      bool active = 3;
      repeated string tags = 4;
    }
  `);
  assert.equal(file.definitions.length, 1);
  const msg = file.definitions[0];
  assert.equal(msg.kind, 'message');
  if (msg.kind !== 'message') return;
  assert.equal(msg.name.name, 'User');
  assert.equal(msg.fields.length, 4);

  const f0 = msg.fields[0];
  assert.equal(f0.kind, 'field');
  if (f0.kind !== 'field') return;
  assert.equal(f0.type.name, 'string');
  assert.equal(f0.name.name, 'name');
  assert.equal(f0.fieldNumber, 1);
  assert.equal(f0.label, null);

  const f3 = msg.fields[3];
  if (f3.kind !== 'field') return;
  assert.equal(f3.label, 'repeated');
  assert.equal(f3.type.name, 'string');
});

test('parses message type reference field', () => {
  const file = parse(`
    syntax = "proto3";
    message Order {
      Address shipping = 1;
      repeated Item items = 2;
    }
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  const f0 = msg.fields[0];
  if (f0.kind !== 'field') return;
  assert.equal(f0.type.name, 'Address');
  // position check
  assert.equal(f0.type.range.start.line, 3);
});

test('parses map field', () => {
  const file = parse(`
    syntax = "proto3";
    message Config {
      map<string, int32> limits = 1;
      map<string, Address> addresses = 2;
    }
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  assert.equal(msg.fields.length, 2);
  const f0 = msg.fields[0];
  assert.equal(f0.kind, 'map');
  if (f0.kind !== 'map') return;
  assert.equal(f0.keyType.name, 'string');
  assert.equal(f0.valueType.name, 'int32');
  assert.equal(f0.name.name, 'limits');
});

test('parses oneof', () => {
  const file = parse(`
    syntax = "proto3";
    message Result {
      oneof value {
        string error = 1;
        int32 count = 2;
      }
    }
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  assert.equal(msg.oneofs.length, 1);
  const oneof = msg.oneofs[0];
  assert.equal(oneof.name.name, 'value');
  assert.equal(oneof.fields.length, 2);
  assert.equal(oneof.fields[0].type.name, 'string');
  assert.equal(oneof.fields[0].name.name, 'error');
});

test('parses nested message and enum', () => {
  const file = parse(`
    syntax = "proto3";
    message Outer {
      message Inner {
        string id = 1;
      }
      enum Status {
        UNKNOWN = 0;
        ACTIVE = 1;
      }
      Inner inner = 1;
      Status status = 2;
    }
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  assert.equal(msg.nestedMessages.length, 1);
  assert.equal(msg.nestedMessages[0].name.name, 'Inner');
  assert.equal(msg.nestedEnums.length, 1);
  assert.equal(msg.nestedEnums[0].name.name, 'Status');
  assert.equal(msg.nestedEnums[0].values.length, 2);
});

test('parses enum', () => {
  const file = parse(`
    syntax = "proto3";
    enum Direction {
      NORTH = 0;
      SOUTH = 1;
      EAST = 2;
      WEST = 3;
    }
  `);
  const def = file.definitions[0];
  assert.equal(def.kind, 'enum');
  if (def.kind !== 'enum') return;
  assert.equal(def.name.name, 'Direction');
  assert.equal(def.values.length, 4);
  assert.equal(def.values[0].name.name, 'NORTH');
  assert.equal(def.values[0].number, 0);
});

test('parses service with rpc', () => {
  const file = parse(`
    syntax = "proto3";
    service UserService {
      rpc GetUser (GetUserRequest) returns (User);
      rpc ListUsers (ListUsersRequest) returns (stream User);
    }
  `);
  const def = file.definitions[0];
  assert.equal(def.kind, 'service');
  if (def.kind !== 'service') return;
  assert.equal(def.name.name, 'UserService');
  assert.equal(def.rpcs.length, 2);
  assert.equal(def.rpcs[0].name.name, 'GetUser');
  assert.equal(def.rpcs[0].inputType.name, 'GetUserRequest');
  assert.equal(def.rpcs[0].outputType.name, 'User');
  assert.equal(def.rpcs[0].inputStream, false);
  assert.equal(def.rpcs[0].outputStream, false);
  assert.equal(def.rpcs[1].outputStream, true);
});

test('parses reserved', () => {
  const file = parse(`
    syntax = "proto3";
    message Foo {
      reserved 2, 15, 9;
      reserved "bar", "baz";
    }
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  assert.equal(msg.reserved.length, 2);
  assert.deepEqual(msg.reserved[0].entries, [2, 15, 9]);
  assert.deepEqual(msg.reserved[1].entries, ['bar', 'baz']);
});

test('parses fully-qualified type reference', () => {
  const file = parse(`
    syntax = "proto3";
    message Foo {
      other.pkg.Bar bar = 1;
    }
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  const f = msg.fields[0];
  if (f.kind !== 'field') return;
  assert.equal(f.type.name, 'other.pkg.Bar');
});

test('error recovery: missing semicolon', () => {
  const file = parse(`
    syntax = "proto3";
    message Foo {
      string name = 1
      int32 age = 2;
    }
  `);
  // should still parse something, with diagnostics
  assert.ok(file.diagnostics.length > 0);
});

test('error recovery: unexpected token at top level', () => {
  const file = parse(`
    syntax = "proto3";
    garbage here;
    message Foo {
      string name = 1;
    }
  `);
  assert.ok(file.diagnostics.length > 0);
  // message after garbage should still be parsed
  assert.equal(file.definitions.length, 1);
  assert.equal(file.definitions[0].kind, 'message');
});

test('position tracking across lines', () => {
  const file = parse(`syntax = "proto3";
message Foo {
  string bar = 1;
}`);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  assert.equal(msg.name.range.start.line, 1);
  assert.equal(msg.name.range.start.character, 8);
  const f = msg.fields[0];
  if (f.kind !== 'field') return;
  assert.equal(f.name.range.start.line, 2);
});

test('parses option statements', () => {
  const file = parse(`
    syntax = "proto3";
    option java_package = "com.example";
    message Foo {
      option deprecated = true;
      string name = 1;
    }
  `);
  assert.equal(file.options.length, 1);
  assert.equal(file.options[0].name, 'java_package');
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  assert.equal(msg.options.length, 1);
  assert.equal(msg.options[0].name, 'deprecated');
});

test('empty message', () => {
  const file = parse(`
    syntax = "proto3";
    message Empty {}
  `);
  const msg = file.definitions[0];
  if (msg.kind !== 'message') return;
  assert.equal(msg.name.name, 'Empty');
  assert.equal(msg.fields.length, 0);
  assert.equal(file.diagnostics.length, 0);
});
