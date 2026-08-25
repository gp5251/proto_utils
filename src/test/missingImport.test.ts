import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type * as vscode from 'vscode';
import { reportMissingImports } from '../loadDiagnostics';
import { ProtoFrontend, createImportResolver } from '../runtime/protoFrontend';
import { scanProto } from '../index/scanner';
import { readProtoFile } from '../runtime/protoEncoding';
import {
  MISSING_IMPORT_CODE,
  computeImportClosure,
  computeImportPath,
  findImportInsertionLine,
  findMissingImports,
  locateTypeRefs,
  normPath,
} from '../analysis/missingImport';
import type { MissingImportFix } from '../analysis/missingImport';

/**
 * 「类型存在但未 import」提醒(0.3.43):ProtoFrontend 全量 load 下这类引用总能 resolve,
 * 但 runner 平面逐文件加载会报 no such type——load 成功路径主动检测并飘红,
 * 诊断挂 missingImportFix 供 Quick Fix 一键补 import。
 */

class FakeDiagnostics {
  readonly calls = new Map<string, vscode.Diagnostic[]>();
  clear(): void {
    this.calls.clear();
  }
  get(uri: vscode.Uri): vscode.Diagnostic[] | undefined {
    return this.calls.get(uri.fsPath);
  }
  set(uri: vscode.Uri, diags: vscode.Diagnostic[]): void {
    this.calls.set(uri.fsPath, diags);
  }
}

const FIXTURE_DIR = path.resolve('testdata/missing-import');
const fixture = (name: string): string => path.join(FIXTURE_DIR, name);

function loadFixtureSchema() {
  const frontend = new ProtoFrontend([FIXTURE_DIR]);
  return { frontend, schema: frontend.load() };
}

function fixPayload(diag: vscode.Diagnostic): MissingImportFix | undefined {
  return (diag as vscode.Diagnostic & { missingImportFix?: MissingImportFix }).missingImportFix;
}

test('漏 import:引用处全部飘红,诊断带 code 与 quick fix payload', () => {
  const { frontend, schema } = loadFixtureSchema();
  const diagnostics = new FakeDiagnostics();
  reportMissingImports(diagnostics as unknown as vscode.DiagnosticCollection, frontend, schema);

  // 只有 consumer.proto 有诊断;其余 fixture(importer/transitive/builtin)干净
  assert.deepEqual([...diagnostics.calls.keys()], [fixture('consumer.proto')]);
  const diags = diagnostics.calls.get(fixture('consumer.proto'))!;
  // dep.v1.Widget 四处(field ×2 + rpc 请求/响应各一) + dep.v1.WidgetKind 一处
  assert.equal(diags.length, 5);
  const lines = diags.map((d) => d.range.start.line).sort((a, b) => a - b);
  assert.deepEqual(lines, [7, 8, 12, 17, 17]);
  for (const diag of diags) {
    assert.equal(diag.severity, 0); // Error
    assert.equal(diag.code, MISSING_IMPORT_CODE);
    assert.equal(diag.source, 'proto-utils');
    assert.match(diag.message, /does not import/);
    assert.equal(fixPayload(diag)?.importPath, 'dep.proto');
  }
  // 首处(field 上的 dep.v1.Widget)精确行列
  const first = diags.find((d) => d.range.start.line === 7)!;
  assert.deepEqual(
    { start: first.range.start, end: first.range.end },
    { start: { line: 7, character: 2 }, end: { line: 7, character: 15 } },
  );
});

test('findMissingImports:已 import / 传递闭包 / google 内建均不产生 finding', () => {
  const { frontend, schema } = loadFixtureSchema();
  const importsOf = (file: string) => scanProto(readProtoFile(file)).imports;
  const findings = findMissingImports(schema, importsOf, createImportResolver(frontend.includeDirs));

  // 全部 finding 只属于 consumer.proto;definingFile 都是 dep.proto
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.equal(f.referencingFile, fixture('consumer.proto'));
    assert.equal(f.definingFile, fixture('dep.proto'));
  }
  // refText 去重:dep.v1.Widget 与 dep.v1.WidgetKind 各一条
  assert.deepEqual(
    findings.map((f) => f.refText).sort(),
    ['dep.v1.Widget', 'dep.v1.WidgetKind'],
  );
  assert.deepEqual(findings.map((f) => f.typeFqn).sort(), ['dep.v1.Widget', 'dep.v1.WidgetKind']);
});

test('computeImportClosure:传递闭包、环终止、bundled google 边跳过、解析失败边跳过', () => {
  const p = (name: string): string => path.join(path.parse(process.cwd()).root, name);
  const importsByFile: Record<string, string[]> = {
    [p('a.proto')]: ['b.proto', 'google/protobuf/empty.proto', 'google/protobuf/custom.proto', 'gone.proto'],
    [p('b.proto')]: ['c.proto'],
    [p('c.proto')]: ['a.proto'], // 环
    [p(path.join('google', 'protobuf', 'custom.proto'))]: [],
  };
  const resolve = (target: string, origin?: string): string | null => {
    if (target === 'gone.proto') return null;
    const full = path.join(path.dirname(origin ?? p('x.proto')), target);
    return full in importsByFile ? full : null;
  };
  const closure = computeImportClosure(p('a.proto'), (f) => importsByFile[f] ?? [], resolve);
  // empty.proto 是 protobufjs 内建 → 跳过;custom.proto 非内建(工作区自供)→ 必须跟随,否则误报
  const expected = new Set(
    ['a.proto', 'b.proto', 'c.proto', path.join('google', 'protobuf', 'custom.proto')].map((f) => normPath(p(f))),
  );
  assert.deepEqual(closure, expected);
});

test('computeImportPath:includeDir 相对优先,不命中退回相对引用文件目录', () => {
  const def = fixture('dep.proto');
  const ref = fixture('consumer.proto');
  assert.equal(computeImportPath(def, ref, [FIXTURE_DIR]), 'dep.proto');
  // includeDir 不含定义文件 → 相对引用文件目录(同目录,裸文件名)
  assert.equal(computeImportPath(def, ref, [path.resolve('testdata')]), 'missing-import/dep.proto');
  assert.equal(computeImportPath(def, ref, [path.resolve('testdata/unresolved')]), 'dep.proto');
});

test('findImportInsertionLine:import 块末尾 > package 后 > syntax 后 > 文件头', () => {
  assert.equal(
    findImportInsertionLine('syntax = "proto3";\npackage a.b;\nimport "x.proto";\nimport "y.proto";\nmessage M {}\n'),
    4,
  );
  assert.equal(findImportInsertionLine('syntax = "proto3";\npackage a.b;\nmessage M {}\n'), 2);
  assert.equal(findImportInsertionLine('syntax = "proto3";\nmessage M {}\n'), 1);
  assert.equal(findImportInsertionLine('message M {}\n'), 0);
  // 注释行不匹配;块注释内部的 import 字样行也不是锚点
  assert.equal(findImportInsertionLine('syntax = "proto3";\n// import "fake.proto";\npackage a.b;\n'), 3);
  assert.equal(
    findImportInsertionLine('syntax = "proto3";\npackage a.b;\n/*\nimport "old.proto";\n*/\nmessage M {}\n'),
    2,
  );
  // 锚点在末行且无尾换行:返回行数,由调用方钳制
  assert.equal(findImportInsertionLine('syntax = "proto3";\npackage a.b;'), 2);
});

test('locateTypeRefs:精确匹配优先,短名兜底,全落空返回空', () => {
  const text = readProtoFile(fixture('consumer.proto'));
  const typeRefs = scanProto(text).typeRefs;

  // 精确:dep.v1.Widget 四处(17 行请求/响应各一)
  const exact = locateTypeRefs(typeRefs, 'dep.v1.Widget');
  assert.deepEqual(exact.map((r) => r.start.line).sort((a, b) => a - b), [7, 12, 17, 17]);
  // 前导点写法归一后与无前导点等价
  assert.deepEqual(locateTypeRefs(typeRefs, '.dep.v1.Widget'), exact);
  // 短名兜底:typeRefs 里没有 "other.v1.Widget",按短名 Widget 匹配到全部 Widget 引用
  const fallback = locateTypeRefs(typeRefs, 'other.v1.Widget');
  assert.deepEqual(fallback, exact);
  // 全落空
  assert.deepEqual(locateTypeRefs(typeRefs, 'dep.v1.NoSuchThing'), []);
});

test('createImportResolver:includeDirs 优先、origin 目录回退、找不到返回 null', () => {
  const resolve = createImportResolver([FIXTURE_DIR]);
  assert.equal(resolve('dep.proto'), fixture('dep.proto'));
  // includeDirs 不含目标时退回 origin 目录
  const narrow = createImportResolver([path.resolve('testdata/unresolved')]);
  assert.equal(narrow('dep.proto', fixture('consumer.proto')), fixture('dep.proto'));
  assert.equal(narrow('dep.proto'), null);
  assert.equal(narrow('no/such/file.proto', fixture('consumer.proto')), null);
});
