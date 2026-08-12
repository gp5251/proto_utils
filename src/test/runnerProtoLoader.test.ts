import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  scanProtoFiles,
  loadProtoDefinitions,
  findProtoFileForService,
} from '../runner/core/protoLoader';
import { serializeServicesForClient, ServiceRegistry } from '../runner/serviceRegistry';

const RUNNER_DIR = path.resolve('testdata/runner');
const FRONTEND_DIR = path.resolve('testdata/frontend');

test('scanProtoFiles finds protos but skips dot dirs, generated/, __fixtures__/ and node_modules/', () => {
  const files = scanProtoFiles(RUNNER_DIR);
  assert.ok(files.some((f) => f.endsWith('dup_a.proto')));
  assert.ok(files.every((f) => !f.includes('__fixtures__')));
  assert.ok(files.every((f) => !f.includes('node_modules')));
  // .hidden/ghost.proto 存在于 fixture 里,必须被点目录规则排除
  assert.ok(files.every((f) => !f.endsWith('ghost.proto')));
});

test('registry reports a clear error when protoDir is a file, not a directory', async () => {
  const registry = new ServiceRegistry();
  const { services, errors } = await registry.load(path.join(RUNNER_DIR, 'dup_a.proto'));
  assert.deepEqual(services, []);
  assert.ok(errors.some((e) => e.includes('is not a directory')));
});

test('loadProtoDefinitions extracts services, methods and ADR-0007 stream flags', () => {
  const protoFiles = scanProtoFiles(FRONTEND_DIR);
  const result = loadProtoDefinitions(protoFiles, FRONTEND_DIR);
  assert.deepEqual(result.errors, []);

  const greeter = result.services.find((s) => s.name === 'Greeter');
  assert.ok(greeter);
  const sayHello = greeter.methods.find((m) => m.name === 'SayHello');
  const subscribe = greeter.methods.find((m) => m.name === 'Subscribe');
  assert.equal(sayHello?.requestStream, false);
  assert.equal(sayHello?.responseStream, false);
  assert.equal(subscribe?.requestStream, false);
  assert.equal(subscribe?.responseStream, true);
});

test('loadProtoDefinitions: empty input → empty output, no errors', () => {
  const result = loadProtoDefinitions([], RUNNER_DIR);
  assert.deepEqual(result.services, []);
  assert.deepEqual(result.errors, []);
});

test('loadProtoDefinitions collects per-file errors without aborting', () => {
  const result = loadProtoDefinitions(['/nonexistent/file.proto'], RUNNER_DIR);
  assert.deepEqual(result.services, []);
  assert.ok(result.errors.length > 0);
});

test('proto3 explicit optional fields are marked, plain fields are not', () => {
  const result = loadProtoDefinitions(scanProtoFiles(RUNNER_DIR), RUNNER_DIR);
  const setVar = result.services
    .flatMap((s) => s.methods)
    .find((m) => m.name === 'SetVar');
  assert.ok(setVar);
  const index = setVar.requestFields.find((f) => f.name === 'index');
  const name = setVar.requestFields.find((f) => f.name === 'name');
  assert.equal(index?.optional, true);
  assert.ok(!name?.optional);
});

test('findProtoFileForService picks the file with most methods when service is duplicated', () => {
  const file = findProtoFileForService(RUNNER_DIR, 'DupService');
  assert.ok(file);
  assert.ok(file.endsWith('dup_b.proto'), `expected dup_b.proto, got ${file}`);
});

test('cross-package same-name messages/enums resolve within the service package', () => {
  const dir = path.resolve('testdata/samename');
  const result = loadProtoDefinitions(scanProtoFiles(dir), dir);
  assert.deepEqual(result.errors, []);

  const svc = result.services.find((s) => s.fullName === 'dup.ld.v1.LDProg');
  assert.ok(svc);
  const method = svc.methods.find((m) => m.name === 'ExecuteOpenLDProg');
  assert.ok(method);

  // req 短名 + service 包提示:不能被 dup.var.v1.OpenReq 的 sOld 遮蔽
  assert.deepEqual(method.requestFields.map((f) => f.name), ['sNew']);

  // nested ref 全限定名:LDElemt_Info 必须是 dup.ld.v1 的(含 sSTprog)
  const elem = method.responseFields.find((f) => f.name === 'LDElemt_Info');
  assert.deepEqual(elem?.nestedFields?.map((f) => f.name), ['iType', 'sName', 'sSTprog']);

  // 字段注释也按包隔离:必须是属主包的注释,而非遮蔽包的
  assert.equal(elem?.nestedFields?.find((f) => f.name === 'iType')?.comment, '属主包元件类型');

  // enum ref 全限定名:mode 必须取 dup.ld.v1.Mode 的值
  const mode = method.responseFields.find((f) => f.name === 'mode');
  assert.deepEqual(mode?.enumValues?.map((v) => v.name), ['NEW_UNSPECIFIED', 'NEW_A']);
});

test('serializeServicesForClient keeps frozen field names plus stream flags', () => {
  const result = loadProtoDefinitions(scanProtoFiles(FRONTEND_DIR), FRONTEND_DIR);
  const payload = serializeServicesForClient(result.services);
  const greeter = payload.find((s) => s.fullName === 'c.Greeter');
  assert.ok(greeter);
  const subscribe = greeter.methods.find((m) => m.name === 'Subscribe');
  assert.deepEqual(Object.keys(subscribe ?? {}).sort(), [
    'name',
    'requestFields',
    'requestStream',
    'requestType',
    'responseSchemaRows',
    'responseStream',
    'responseType',
  ]);
  assert.equal(subscribe?.responseStream, true);
});
