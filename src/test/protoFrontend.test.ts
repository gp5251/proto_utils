import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ProtoFrontend, ProtoLoadError } from '../runtime/protoFrontend';

const FIXTURE_DIR = path.resolve('testdata/frontend');

function makeFrontend(dir: string = FIXTURE_DIR): ProtoFrontend {
  return new ProtoFrontend([dir]);
}

test('loads all proto files under includeDirs, resolved and keepCase-preserved', () => {
  const schema = makeFrontend().load();

  const bar = schema.root.lookupType('c.Bar');
  const fooField = bar.fields.f;
  assert.equal(fooField.resolvedType?.fullName, '.a.b.Foo');

  // keepCase: emitter plane sees declared names, not camelized ones
  const foo = schema.root.lookupType('a.b.Foo');
  assert.deepEqual(Object.keys(foo.fields), ['snake_name', 'big_num']);
});

test('attributes every message/enum/service to the file that declares it', () => {
  const schema = makeFrontend().load();
  const decl = schema.declarations;

  assert.equal(decl.get('a.b.Foo'), path.join(FIXTURE_DIR, 'base.proto'));
  assert.equal(decl.get('c.Bar'), path.join(FIXTURE_DIR, 'sub', 'user.proto'));
  assert.equal(decl.get('c.Bar.Inner'), path.join(FIXTURE_DIR, 'sub', 'user.proto'));
  assert.equal(decl.get('c.Kind'), path.join(FIXTURE_DIR, 'sub', 'user.proto'));
  assert.equal(decl.get('c.Greeter'), path.join(FIXTURE_DIR, 'sub', 'user.proto'));
});

test('memoizes the schema until invalidate()', () => {
  const frontend = makeFrontend();
  const first = frontend.load();
  assert.equal(frontend.load(), first);
  frontend.invalidate();
  assert.notEqual(frontend.load(), first);
});

test('load failure throws ProtoLoadError with file and line', () => {
  const frontend = makeFrontend(path.resolve('testdata/frontend-broken'));
  assert.throws(() => frontend.load(), (err: unknown) => {
    assert.ok(err instanceof ProtoLoadError);
    assert.match(err.file ?? '', /bad\.proto$/);
    // protobufjs 定位在非法 token 所在行(第 5 行的 }),而非声明开始行
    assert.equal(err.line, 5);
    return true;
  });
});

test('memoizes the error; a fixed file only loads after invalidate()', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-frontend-'));
  const file = path.join(dir, 'flip.proto');
  fs.writeFileSync(file, 'syntax = "proto3"; message Broken { string }\n');

  const frontend = makeFrontend(dir);
  assert.throws(() => frontend.load(), ProtoLoadError);

  fs.writeFileSync(file, 'syntax = "proto3"; message Fixed { string ok = 1; }\n');
  assert.throws(() => frontend.load(), ProtoLoadError);

  frontend.invalidate();
  assert.ok(frontend.load().root.lookupType('Fixed'));
});
