import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { ServiceRegistry } from '../runner/serviceRegistry';
import { ProtoFrontend } from '../runtime/protoFrontend';
import { scanProto } from '../index/scanner';

/**
 * 端到端:真实语料(rpc_runner 的 44 个工业 proto)走通合并后的三条平面——
 * 语义前端(proto-loader)、调用面 schema 提取(ServiceRegistry)、位置索引层(scanner)。
 * 语料是本地业务数据(gitignored),缺失时跳过。
 */

const CORPUS = path.resolve('../rpc_runner/protos');
const corpusPresent = fs.existsSync(CORPUS);

test('corpus: 语义前端全量加载真实 proto', { skip: !corpusPresent }, () => {
  const frontend = new ProtoFrontend([CORPUS]);
  const schema = frontend.load();
  // 实测基线(2026-07-31):45 个文件(44 顶层 + protos/__fixtures__/test.proto),506 个声明
  assert.ok(schema.files.length >= 45, `expected >=45 files, got ${schema.files.length}`);
  assert.ok(schema.declarations.size >= 500, `expected >=500 declarations, got ${schema.declarations.size}`);
});

test('corpus: 调用面提取服务且含流式方法', { skip: !corpusPresent }, async () => {
  const registry = new ServiceRegistry();
  const { services, errors } = await registry.load(CORPUS);
  assert.deepEqual(errors, []);
  // 实测基线:5 个服务(大量 message-only proto),其中 6 个流式方法
  assert.ok(services.length >= 5, `expected >=5 services, got ${services.length}`);

  const streamMethods = services.flatMap((s) => s.methods).filter((m) => m.requestStream || m.responseStream);
  assert.ok(streamMethods.length >= 6, 'corpus has streaming rpcs, extractor must surface them');

  const servicesWithComments = services.filter((s) =>
    s.methods.some((m) => m.requestFields.some((f) => f.comment)),
  );
  assert.ok(servicesWithComments.length > 0, 'proto comments should reach FieldInfo');
});

test('corpus: 位置索引层对每个文件产出服务定义点,零异常', { skip: !corpusPresent }, () => {
  const protoFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.proto')) protoFiles.push(full);
    }
  };
  walk(CORPUS);
  assert.ok(protoFiles.length >= 45);

  let serviceCount = 0;
  let methodCount = 0;
  for (const file of protoFiles) {
    const source = fs.readFileSync(file, 'utf-8');
    const scanned = scanProto(source);
    serviceCount += scanned.services.length;
    methodCount += scanned.services.reduce((n, s) => n + s.methods.length, 0);
  }
  // 实测基线:6 个 service 块(其一无方法),191 个 rpc 方法点
  assert.ok(serviceCount >= 6, `expected >=6 service points, got ${serviceCount}`);
  assert.ok(methodCount >= 190, `expected >=190 rpc methods, got ${methodCount}`);
});
