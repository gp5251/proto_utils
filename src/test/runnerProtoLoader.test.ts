import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanProtoFiles,
  loadProtoDefinitions,
  findProtoFileForService,
  clearServiceFileCache,
  resetProtoLoaderCache,
} from '../runner/core/protoLoader';
import { serializeServicesForClient, ServiceRegistry } from '../runner/serviceRegistry';
import { getPackageDefinition } from '../runner/core/protoCache';
import type { ScanExcludes } from '../runner/config';

const RUNNER_DIR = path.resolve('testdata/runner');
const FRONTEND_DIR = path.resolve('testdata/frontend');
const DUP_DIR = path.resolve('testdata/dupsvc');

const EXCL_COPY: ScanExcludes = { names: new Set(['vendor_copy']), paths: [] };

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

test('findProtoFileForService 全限定名精确命中所属包(跨包同短名不串)', () => {
  // 带 excludes 排掉 vendor_copy:同 fullName 的陈旧拷贝不参选,结果才确定
  const alpha = findProtoFileForService(DUP_DIR, 'alpha.Echo', EXCL_COPY);
  assert.ok(alpha, 'alpha.Echo 应命中');
  assert.ok(alpha.endsWith('alpha.proto') && !alpha.includes('vendor_copy'), `expected src alpha.proto, got ${alpha}`);

  const beta = findProtoFileForService(DUP_DIR, 'beta.Echo', EXCL_COPY);
  assert.ok(beta, 'beta.Echo 应命中');
  assert.ok(beta.endsWith('beta.proto'), `expected beta.proto, got ${beta}`);
});

test('findProtoFileForService 裸短名沿用「最多方法」启发式(Echo → beta)', () => {
  const file = findProtoFileForService(DUP_DIR, 'Echo', EXCL_COPY);
  assert.ok(file);
  assert.ok(file.endsWith('beta.proto'), `expected beta.proto, got ${file}`);
});

test('findProtoFileForService 尊重 excludes:陈旧拷贝不参选', () => {
  // 无排除:vendor_copy 与 src 同 fullName 但方法更多,被选中(Send 不在其中)
  const withoutExcludes = findProtoFileForService(DUP_DIR, 'alpha.Echo');
  assert.ok(withoutExcludes);
  assert.ok(withoutExcludes.includes('vendor_copy'), `expected stale copy, got ${withoutExcludes}`);

  // 有排除:只剩 src 的 alpha.proto
  const withExcludes = findProtoFileForService(DUP_DIR, 'alpha.Echo', EXCL_COPY);
  assert.ok(withExcludes);
  assert.ok(withExcludes.endsWith('alpha.proto') && !withExcludes.includes('vendor_copy'), `expected src alpha.proto, got ${withExcludes}`);
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

// ---- 服务→定义文件 解析缓存(#12 性能,0.3.44)----

test('findProtoFileForService 结果缓存:重复查询命中缓存,失效后重算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-file-cache-'));
  fs.writeFileSync(
    path.join(dir, 'a.proto'),
    'syntax = "proto3"; service Svc { rpc M1(A) returns (A); } message A { string id = 1; }\n',
  );
  assert.ok(findProtoFileForService(dir, 'Svc')?.endsWith('a.proto'));

  // 写入方法更多的 b.proto:新扫描会赢;但未失效前必须命中缓存(钉住「有缓存」行为)
  fs.writeFileSync(
    path.join(dir, 'b.proto'),
    'syntax = "proto3"; service Svc { rpc M1(A) returns (A); rpc M2(A) returns (A); } message A { string id = 1; }\n',
  );
  assert.ok(
    findProtoFileForService(dir, 'Svc')?.endsWith('a.proto'),
    '未失效前必须命中缓存,不得重扫',
  );

  clearServiceFileCache();
  assert.ok(findProtoFileForService(dir, 'Svc')?.endsWith('b.proto'), '失效后重算,最多方法者胜');

  // registry.invalidate 的既有钩子(resetProtoLoaderCache)必须连带清本缓存:
  // b 删掉 M2 后与 a 打平,目录序 a 先 → 重算回 a
  fs.writeFileSync(
    path.join(dir, 'b.proto'),
    'syntax = "proto3"; service Svc { rpc M1(A) returns (A); } message A { string id = 1; }\n',
  );
  resetProtoLoaderCache();
  assert.ok(findProtoFileForService(dir, 'Svc')?.endsWith('a.proto'), 'resetProtoLoaderCache 必须连带清服务文件缓存');
});

test('findProtoFileForService 缓存按 excludes 对象引用区分,不串线', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-file-cache-excl-'));
  fs.mkdirSync(path.join(dir, 'stale'));
  fs.writeFileSync(
    path.join(dir, 'main.proto'),
    'syntax = "proto3"; package m; service Duo { rpc M1(D) returns (D); } message D { string id = 1; }\n',
  );
  fs.writeFileSync(
    path.join(dir, 'stale', 'duo.proto'),
    'syntax = "proto3"; package m; service Duo { rpc M1(D) returns (D); rpc M2(D) returns (D); rpc M3(D) returns (D); } message D { string id = 1; }\n',
  );

  const noExcludes = findProtoFileForService(dir, 'm.Duo');
  assert.ok(noExcludes?.includes('stale'), '无排除时 stale(3 方法)胜');
  const excl: ScanExcludes = { names: new Set(['stale']), paths: [] };
  assert.ok(findProtoFileForService(dir, 'm.Duo', excl)?.endsWith('main.proto'), '不同 excludes 各自解析');
  assert.ok(findProtoFileForService(dir, 'm.Duo')?.includes('stale'), '原键的缓存不受另一键污染');
});

test('registry.invalidate 保留 protoCache 指纹门:未变文件不重 loadSync(0.3.48 增量重载)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-proto-cache-'));
  const file = path.join(dir, 'a.proto');
  fs.writeFileSync(
    file,
    'syntax = "proto3";\npackage p;\nservice Svc { rpc M(A) returns (A); }\nmessage A { string id = 1; }\n',
  );

  const registry = new ServiceRegistry();
  await registry.load(dir); // 填充 protoCache
  const defBefore = getPackageDefinition(file, dir); // 命中缓存

  registry.invalidate(); // 清 cached + serviceFileCache,保留 protoCache
  const defAfter = getPackageDefinition(file, dir); // 仍命中缓存(未被盲清)
  assert.equal(defBefore, defAfter, 'invalidate 不得盲清 protoCache(其 mtime 指纹门自理增量)');

  // 功能不回归:invalidate 后 load 仍产出正确服务
  const { services } = await registry.load(dir);
  assert.ok(services.some((s) => s.fullName === 'p.Svc'), 'invalidate 后仍能加载服务');
});
