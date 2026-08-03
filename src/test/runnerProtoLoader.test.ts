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

test('scanProtoFiles finds protos but skips generated/, __fixtures__/ and node_modules/', () => {
  const files = scanProtoFiles(RUNNER_DIR);
  assert.ok(files.some((f) => f.endsWith('dup_a.proto')));
  assert.ok(files.every((f) => !f.includes('__fixtures__')));
  assert.ok(files.every((f) => !f.includes('node_modules')));
});

test('registry reports a clear error when protoDir is a file, not a directory', async () => {
  const registry = new ServiceRegistry();
  const { services, errors } = await registry.load(path.join(RUNNER_DIR, 'dup_a.proto'));
  assert.deepEqual(services, []);
  assert.ok(errors.some((e) => e.includes('不是目录')));
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
