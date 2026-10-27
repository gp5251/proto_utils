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
import { EMPTY_SCAN_EXCLUDES, type ScanExcludes } from '../runner/config';

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

test('loadProtoDefinitions:被 import 的枚举文件变更须反映到 enumValues(0.3.77 现场回归)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-import-stale-'));
  const enumFile = path.join(dir, 'z_enum.proto');
  const svcFile = path.join(dir, 'a_svc.proto');
  fs.writeFileSync(enumFile, 'syntax = "proto3";\npackage p;\nenum View { VIEW_UNSPECIFIED = 0; }\n');
  fs.writeFileSync(
    svcFile,
    'syntax = "proto3";\npackage p;\nimport "z_enum.proto";\nmessage Req { string id = 1; }\nmessage Res { View view = 1; }\nservice Svc { rpc M(Req) returns (Res); }\n',
  );

  // 服务文件排扫描序首位:修复前它内嵌的旧枚举拷贝会被 findTypeDef 先命中
  const files = [svcFile, enumFile];
  const before = loadProtoDefinitions(files, dir);
  const viewBefore = before.services[0].methods[0].responseFields.find((f) => f.name === 'view');
  assert.deepEqual(viewBefore?.enumValues?.map((v) => v.name), ['VIEW_UNSPECIFIED']);

  fs.writeFileSync(enumFile, 'syntax = "proto3";\npackage p;\nenum View { VIEW_UNSPECIFIED = 0; VIEW_SYS = 64; }\n');
  const after = loadProtoDefinitions(files, dir);
  const viewAfter = after.services[0].methods[0].responseFields.find((f) => f.name === 'view');
  assert.deepEqual(viewAfter?.enumValues?.map((v) => v.name), ['VIEW_UNSPECIFIED', 'VIEW_SYS']);
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

// ---- 钉住文件(0.3.83):CodeLens 点击的 proto 文件不必落在 runner.protoDir 内 ----

/** 造两个互不包含的目录:configured 作为 protoDir,outside 放待钉住的 proto。 */
function makePinFixture(prefix: string): { configured: string; outside: string; outsideFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configured = path.join(root, 'configured');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(configured);
  fs.mkdirSync(outside);
  fs.writeFileSync(
    path.join(configured, 'a.proto'),
    'syntax = "proto3";\npackage cfg;\nservice A { rpc M1(P) returns (P); }\nmessage P { string id = 1; }\n',
  );
  const outsideFile = path.join(outside, 'b.proto');
  fs.writeFileSync(
    outsideFile,
    'syntax = "proto3";\npackage out;\nservice B { rpc M2(P) returns (P); }\nmessage P { string id = 1; }\n',
  );
  return { configured, outside, outsideFile };
}

test('registry.pin:protoDir 外的文件钉住后进入服务列表', async () => {
  const { configured, outsideFile } = makePinFixture('pin-outside-');
  const registry = new ServiceRegistry();

  const before = await registry.load(configured);
  assert.ok(before.services.some((s) => s.fullName === 'cfg.A'), '配置目录内的服务本就该在');
  assert.ok(!before.services.some((s) => s.fullName === 'out.B'), '钉住前不得出现目录外的服务');

  assert.equal(registry.pin(outsideFile, configured), true, '首次钉住应报告变化(调用方据此重载)');
  assert.equal(registry.pin(outsideFile, configured), false, '重复钉住不应报告变化(避免无谓重载)');

  const after = await registry.load(configured);
  assert.ok(after.services.some((s) => s.fullName === 'out.B'), '钉住文件的服务必须进列表');
  assert.ok(after.services.some((s) => s.fullName === 'cfg.A'), '原目录服务不受影响');
  assert.deepEqual(registry.pinnedFiles, [path.resolve(outsideFile)]);
});

test('registry.pin:protoDir 内的文件不钉住,同一份缓存原样复用(热路径零开销)', async () => {
  const { configured } = makePinFixture('pin-inside-');
  const inside = path.join(configured, 'a.proto');
  const registry = new ServiceRegistry();

  const first = await registry.load(configured);
  assert.equal(registry.pin(inside, configured), false, '已在扫描范围内,钉住是多余的');
  assert.deepEqual(registry.pinnedFiles, []);
  assert.equal(await registry.load(configured), first, '未钉住则必须复用同一份缓存实例,不得触发重解析');
});

test('registry.load:protoDir 不存在时钉住文件仍撑起服务列表(错误并列上报)', async () => {
  const { outsideFile } = makePinFixture('pin-nodir-');
  const missing = path.join(path.dirname(outsideFile), 'no-such-dir');
  const registry = new ServiceRegistry();

  registry.pin(outsideFile, missing);
  const { services, errors } = await registry.load(missing);
  assert.ok(services.some((s) => s.fullName === 'out.B'), '配置目录坏掉也不该让点击入口一无所获');
  assert.ok(errors.some((e) => e.includes('not found')), 'protoDir 缺失仍如实上报,不被钉住结果掩盖');
});

test('registry.pin:钉住文件的同目录 import 照常解析(无需额外 include 根)', async () => {
  // 钉住 <outside>/pkg/b.proto,它 import "dep.proto" 且 dep.proto 就在同目录。
  // proto-loader 对 includeDirs 全落空的 import 回退到「origin 文件所在目录」,
  // 故追加 dirname(钉住文件) 是空操作——本测试钉住这一事实,防将来画蛇添足。
  const { configured } = makePinFixture('pin-import-');
  const pkgDir = path.join(path.dirname(configured), 'outside', 'pkg');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'dep.proto'),
    'syntax = "proto3";\npackage out;\nmessage Req { string name = 1; int32 count = 2; }\n',
  );
  const pinnedFile = path.join(pkgDir, 'b.proto');
  fs.writeFileSync(
    pinnedFile,
    'syntax = "proto3";\npackage out;\nimport "dep.proto";\nservice B { rpc M2(Req) returns (Req); }\n',
  );

  const registry = new ServiceRegistry();
  registry.pin(pinnedFile, configured);
  const { services, errors } = await registry.load(configured);
  assert.deepEqual(errors, [], '同目录 import 不该产生解析错误');

  const m2 = services.find((s) => s.fullName === 'out.B')?.methods.find((m) => m.name === 'M2');
  assert.ok(m2, '钉住文件的服务与方法必须进列表');
  assert.deepEqual(
    m2.requestFields.map((f) => f.name),
    ['name', 'count'],
    '请求字段来自被 import 的文件,证明 import 解析成功',
  );
});

test('registry.pin:只清服务列表缓存,protoCache 指纹门与 serviceFileCache 保留(0.3.48 卡顿教训)', async () => {
  const { configured, outsideFile } = makePinFixture('pin-cache-');
  const insideFile = path.join(configured, 'a.proto');
  const registry = new ServiceRegistry();

  await registry.load(configured);
  const defBefore = getPackageDefinition(insideFile, configured);
  // 预热「服务→定义文件」解析缓存:钉住后必须仍命中,不得整树重扫(同步 IO,卡顿根因)
  assert.ok(findProtoFileForService(configured, 'cfg.A')?.endsWith('a.proto'));

  registry.pin(outsideFile, configured);
  assert.equal(getPackageDefinition(insideFile, configured), defBefore, 'pin 不得盲清 protoCache');

  // 沿用本文件既有的观察手法:写入方法更多的竞争文件,未失效前必须仍命中旧答案
  fs.writeFileSync(
    path.join(configured, 'zzz.proto'),
    'syntax = "proto3";\npackage cfg;\nservice A { rpc M1(P) returns (P); rpc M9(P) returns (P); }\nmessage P { string id = 1; }\n',
  );
  assert.ok(
    findProtoFileForService(configured, 'cfg.A')?.endsWith('a.proto'),
    'pin 不得连带清 serviceFileCache:否则每次点击 CodeLens 都重扫整棵 protoDir',
  );
});

test('registry.pin:文件不存在时不钉住(未保存的 untitled 文档点 ▶ 不该脏钉)', () => {  const { configured } = makePinFixture('pin-missing-');
  const registry = new ServiceRegistry();
  const ghost = path.join(path.dirname(configured), 'outside', 'ghost.proto');
  assert.equal(
    registry.pin(ghost, configured),
    false,
    '不存在的文件钉不住:否则每次点击都报告变化并触发一次无谓的服务列表重载',
  );
  assert.deepEqual(registry.pinnedFiles, []);
});

test('registry.pin:protoDir 为空串(无工作区文件夹)时照样钉住,不误判为「已在范围内」', () => {
  // 无工作区时 resolveRunnerConfig 给出 protoDir='',而 path.resolve('') === cwd:
  // 不特判就会把仓库内任何文件都判成「在 protoDir 内」→ 永不钉住 → 服务列表恒空。
  // 这正是「单独打开一个 proto 文件点 ▶」的场景。
  const registry = new ServiceRegistry();
  const file = path.resolve('testdata/dupsvc/alpha.proto');
  assert.equal(registry.pin(file, ''), true, '空 protoDir 等于没有范围,存在的文件就该钉住');
  assert.deepEqual(registry.pinnedFiles, [file]);
});

// ---- 钉住优先的服务定义文件解析(0.3.83):调用面靠它找到目录外的定义文件 ----

test('findProtoFileForService:钉住文件让 protoDir 内扫不到的服务可解析', () => {
  const { configured, outsideFile } = makePinFixture('find-pin-');
  assert.equal(findProtoFileForService(configured, 'out.B'), null, '未钉住:protoDir 里确实没有 out.B');
  assert.equal(
    findProtoFileForService(configured, 'out.B', EMPTY_SCAN_EXCLUDES, [outsideFile]),
    path.resolve(outsideFile),
    '钉住后必须直接命中点击的文件,否则调用面报 Service not found',
  );
});

test('findProtoFileForService:同 fullName 在 protoDir 内也有拷贝时,仍以钉住(点击)的文件为准', () => {
  const { configured, outsideFile } = makePinFixture('find-pin-dup-');
  // 目录内放一个同 fullName 但方法更多的拷贝:不钉住时「最多方法」启发式会选它
  fs.writeFileSync(
    path.join(configured, 'stale_b.proto'),
    'syntax = "proto3";\npackage out;\nservice B { rpc M2(P) returns (P); rpc M3(P) returns (P); rpc M4(P) returns (P); }\nmessage P { string id = 1; }\n',
  );
  clearServiceFileCache();
  assert.ok(
    findProtoFileForService(configured, 'out.B')?.endsWith('stale_b.proto'),
    '前置条件:未钉住时目录内拷贝(方法更多)胜出',
  );
  assert.equal(
    findProtoFileForService(configured, 'out.B', EMPTY_SCAN_EXCLUDES, [outsideFile]),
    path.resolve(outsideFile),
    '钉住优先必须早于缓存与扫描:用户点的就是这个文件,它是权威定义源',
  );
});

test('findProtoFileForService:钉住集为空时行为与既往完全一致(不回归)', () => {
  const { configured } = makePinFixture('find-pin-empty-');
  assert.equal(
    findProtoFileForService(configured, 'cfg.A', EMPTY_SCAN_EXCLUDES, []),
    findProtoFileForService(configured, 'cfg.A'),
    '空钉住集不得改变既有解析结果',
  );
  assert.equal(
    findProtoFileForService(configured, 'nope.Missing', EMPTY_SCAN_EXCLUDES, []),
    null,
    '钉住文件里没有该服务时仍按 protoDir 扫描判定,扫不到即 null',
  );
});

test('findProtoFileForService:钉住文件里查无此服务时回落到 protoDir 扫描', () => {
  const { configured, outsideFile } = makePinFixture('find-pin-fallback-');
  assert.ok(
    findProtoFileForService(configured, 'cfg.A', EMPTY_SCAN_EXCLUDES, [outsideFile])?.endsWith('a.proto'),
    '钉住的是 out.B 的文件,查 cfg.A 必须仍从 protoDir 扫到',
  );
});
