import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { ProtoFrontend } from '../runtime/protoFrontend';
import { registerCodeGenCommand } from '../codegen/command';

/**
 * 命令层体验回归(0.3.89):单文件碰撞检测、非 proto 提示、批量进度/取消/逐文件错误、
 * 配置枚举校验、outputDir 越界校验。vscode 走 scripts/vscodeStub.ts 替身。
 */

// 运行期 'vscode' 被 esbuild 别名到 scripts/vscodeStub.ts(与生产代码同一模块实例);
// 类型检查面对的是 @types/vscode,测试注入面经断言取用,避免直接 import rootDir 外的 stub。
interface CodeGenStubSurface {
  stubMessages: { kind: 'error' | 'info' | 'warning'; message: string; items: string[] }[];
  stubOpened: { fsPath: string }[];
  resetCodeGenStub(): void;
  setWorkspaceFolders(dirs: string[]): void;
  setActiveTextEditor(uri: { fsPath: string } | undefined): void;
  setConfigOverrides(values: Record<string, unknown>): void;
  setNextMessageChoice(choice: string | undefined): void;
  setWriteFailure(fsPath: string): void;
  setCancelAfterReports(n: number): void;
}
const {
  stubMessages,
  stubOpened,
  resetCodeGenStub,
  setWorkspaceFolders,
  setActiveTextEditor,
  setConfigOverrides,
  setNextMessageChoice,
  setWriteFailure,
  setCancelAfterReports,
} = vscode as unknown as CodeGenStubSurface;
const Uri = vscode.Uri;

function fixtureDir(t: TestContext, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-cmd-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function register(dir: string): void {
  const context = { subscriptions: [] as { dispose(): void }[] };
  registerCodeGenCommand(context as unknown as vscode.ExtensionContext, new ProtoFrontend([dir]), () => undefined);
}

const A_PROTO = 'syntax = "proto3";\nmessage A { string id = 1; }\n';
const B_PROTO = 'syntax = "proto3";\nmessage B { string id = 1; }\n';

test('generateTypes:落盘 + 通知 Open 动作可打开产物', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO });
  setWorkspaceFolders([dir]);
  register(dir);
  setNextMessageChoice('Open');
  await vscode.commands.executeCommand('protoUtils.generateTypes', Uri.file(path.join(dir, 'a.proto')));
  const outFile = path.join(dir, 'generated', 'a.ts');
  assert.ok(fs.existsSync(outFile), '产物落盘');
  assert.ok(stubMessages.some((m) => m.kind === 'info' && m.message.includes('Generated')), '成功通知');
  assert.equal(stubOpened.length, 1, '点 Open 打开产物');
  assert.equal(stubOpened[0].fsPath, outFile);
});

test('generateTypes:内容未变 → already up to date,不重复写', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO });
  setWorkspaceFolders([dir]);
  register(dir);
  const uri = Uri.file(path.join(dir, 'a.proto'));
  await vscode.commands.executeCommand('protoUtils.generateTypes', uri);
  const mtime = fs.statSync(path.join(dir, 'generated', 'a.ts')).mtimeMs;
  await vscode.commands.executeCommand('protoUtils.generateTypes', uri);
  assert.ok(stubMessages.some((m) => m.kind === 'info' && m.message.includes('up to date')), '未变提示');
  assert.equal(fs.statSync(path.join(dir, 'generated', 'a.ts')).mtimeMs, mtime, '未变不落盘');
});

test('generateTypes:活动编辑器非 proto 文件 → 明确提示而非 include dirs 误导(0.3.89)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO });
  setWorkspaceFolders([dir]);
  register(dir);
  setActiveTextEditor(Uri.file(path.join(dir, 'notes.txt')));
  await vscode.commands.executeCommand('protoUtils.generateTypes');
  const err = stubMessages.find((m) => m.kind === 'error');
  assert.ok(err, '须报错');
  assert.ok(err.message.includes('not a .proto file'), `提示应说明非 proto 文件,实际: ${err.message}`);
});

test('generateTypes:无工作区 → 报错', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO });
  register(dir);
  await vscode.commands.executeCommand('protoUtils.generateTypes', Uri.file(path.join(dir, 'a.proto')));
  assert.ok(stubMessages.some((m) => m.kind === 'error' && m.message.includes('No workspace folder')));
});

test('generateTypes:单文件也做输出碰撞检测(package 模式同包),拒绝静默覆盖(0.3.89)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, {
    'a.proto': 'syntax = "proto3";\npackage shared;\nmessage A { string id = 1; }\n',
    'b.proto': 'syntax = "proto3";\npackage shared;\nmessage B { string id = 1; }\n',
  });
  setWorkspaceFolders([dir]);
  setConfigOverrides({ 'protoUtils.codeGen.pathMapping': 'package' });
  register(dir);
  await vscode.commands.executeCommand('protoUtils.generateTypes', Uri.file(path.join(dir, 'a.proto')));
  const err = stubMessages.find((m) => m.kind === 'error');
  assert.ok(err, '须报错');
  assert.ok(err.message.includes('conflict'), `提示应说明输出冲突,实际: ${err.message}`);
  assert.ok(!fs.existsSync(path.join(dir, 'generated')), '冲突时不得写盘');
});

test('generateTypes:写盘失败 → 点名文件的明确报错,而非未处理拒绝(0.3.89)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO });
  setWorkspaceFolders([dir]);
  register(dir);
  setWriteFailure(path.join(dir, 'generated', 'a.ts'));
  await vscode.commands.executeCommand('protoUtils.generateTypes', Uri.file(path.join(dir, 'a.proto')));
  const err = stubMessages.find((m) => m.kind === 'error');
  assert.ok(err, '写失败须报错');
  assert.ok(err.message.includes('a.proto'), `报错应点名文件,实际: ${err.message}`);
});

test('generateAllTypes:同包碰撞整体拒绝(既有行为回归)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, {
    'a.proto': 'syntax = "proto3";\npackage shared;\nmessage A { string id = 1; }\n',
    'b.proto': 'syntax = "proto3";\npackage shared;\nmessage B { string id = 1; }\n',
  });
  setWorkspaceFolders([dir]);
  setConfigOverrides({ 'protoUtils.codeGen.pathMapping': 'package' });
  register(dir);
  await vscode.commands.executeCommand('protoUtils.generateAllTypes');
  assert.ok(stubMessages.some((m) => m.kind === 'error' && m.message.includes('conflict')));
  assert.ok(!fs.existsSync(path.join(dir, 'generated')), '冲突时不得写盘');
});

test('generateAllTypes:单文件写失败不中断批量,汇总报错(0.3.89)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO, 'b.proto': B_PROTO });
  setWorkspaceFolders([dir]);
  register(dir);
  setWriteFailure(path.join(dir, 'generated', 'b.ts'));
  await vscode.commands.executeCommand('protoUtils.generateAllTypes');
  assert.ok(fs.existsSync(path.join(dir, 'generated', 'a.ts')), 'a 正常写入');
  assert.ok(!fs.existsSync(path.join(dir, 'generated', 'b.ts')), 'b 写入失败');
  const err = stubMessages.find((m) => m.kind === 'error');
  assert.ok(err, '失败须有错误汇总');
  assert.ok(err.message.includes('failed'), `汇总应说明失败,实际: ${err.message}`);
  assert.ok(err.message.includes('b.proto'), `汇总应点名失败文件,实际: ${err.message}`);
});

test('generateAllTypes:可取消,报告已完成部分(0.3.89)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO, 'b.proto': B_PROTO, 'c.proto': 'syntax = "proto3";\nmessage C { string id = 1; }\n' });
  setWorkspaceFolders([dir]);
  register(dir);
  setCancelAfterReports(1);
  await vscode.commands.executeCommand('protoUtils.generateAllTypes');
  assert.ok(fs.existsSync(path.join(dir, 'generated', 'a.ts')), '取消前第一个文件已写');
  assert.ok(!fs.existsSync(path.join(dir, 'generated', 'b.ts')), '取消后不再写');
  assert.ok(stubMessages.some((m) => m.message.includes('cancelled')), `须报告取消,实际: ${JSON.stringify(stubMessages)}`);
});

test('generateAllTypes:正常批量报告写入数', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO, 'b.proto': B_PROTO });
  setWorkspaceFolders([dir]);
  register(dir);
  await vscode.commands.executeCommand('protoUtils.generateAllTypes');
  assert.ok(fs.existsSync(path.join(dir, 'generated', 'a.ts')));
  assert.ok(fs.existsSync(path.join(dir, 'generated', 'b.ts')));
  assert.ok(stubMessages.some((m) => m.kind === 'info' && m.message.includes('Generated 2 files')));
});

test('配置校验:非法 enumStyle 回退默认 enum(0.3.89)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': 'syntax = "proto3";\nenum E { X = 0; }\n' });
  setWorkspaceFolders([dir]);
  setConfigOverrides({ 'protoUtils.codeGen.enumStyle': 'bogus' });
  register(dir);
  await vscode.commands.executeCommand('protoUtils.generateTypes', Uri.file(path.join(dir, 'a.proto')));
  const out = fs.readFileSync(path.join(dir, 'generated', 'a.ts'), 'utf-8');
  assert.ok(out.includes('export enum E'), '非法值回退默认 enum 风格');
});

test('配置校验:非法 pathMapping/oneofStyle/importExtension 回退默认(0.3.89)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, {
    'a.proto': 'syntax = "proto3";\nmessage M { oneof v { string s = 1; int32 n = 2; } }\n',
    'b.proto': 'syntax = "proto3";\nimport "a.proto";\nmessage N { M m = 1; }\n',
  });
  setWorkspaceFolders([dir]);
  setConfigOverrides({
    'protoUtils.codeGen.pathMapping': 'bogus',
    'protoUtils.codeGen.oneofStyle': 'bogus',
    'protoUtils.codeGen.importExtension': 'bogus',
  });
  register(dir);
  await vscode.commands.executeCommand('protoUtils.generateAllTypes');
  const outB = fs.readFileSync(path.join(dir, 'generated', 'b.ts'), 'utf-8');
  assert.ok(outB.includes("from './a.ts'"), 'importExtension 非法 → 默认 ts 后缀');
  const outA = fs.readFileSync(path.join(dir, 'generated', 'a.ts'), 'utf-8');
  assert.ok(outA.includes('export interface M'), 'oneofStyle 非法 → 默认 optional(interface)');
  assert.ok(fs.existsSync(path.join(dir, 'generated', 'a.ts')), 'pathMapping 非法 → 默认 file 映射');
});

test('outputDir 校验:绝对路径拒绝(0.3.89)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO });
  setWorkspaceFolders([dir]);
  setConfigOverrides({ 'protoUtils.codeGen.outputDir': path.join(dir, '..', 'abs-out') });
  register(dir);
  await vscode.commands.executeCommand('protoUtils.generateTypes', Uri.file(path.join(dir, 'a.proto')));
  const err = stubMessages.find((m) => m.kind === 'error');
  assert.ok(err, '须报错');
  assert.ok(err.message.includes('relative'), `提示应说明须为相对路径,实际: ${err.message}`);
});

test('outputDir 校验:../ 越界工作区拒绝(0.3.89)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO });
  setWorkspaceFolders([dir]);
  setConfigOverrides({ 'protoUtils.codeGen.outputDir': '../outside' });
  register(dir);
  await vscode.commands.executeCommand('protoUtils.generateTypes', Uri.file(path.join(dir, 'a.proto')));
  const err = stubMessages.find((m) => m.kind === 'error');
  assert.ok(err, '须报错');
  assert.ok(err.message.includes('outside the workspace'), `提示应说明越界,实际: ${err.message}`);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'outside')), '不得写出工作区');
});

test('纯 import 聚合文件:提示无产物,不落空文件(既有行为回归)', async (t) => {
  resetCodeGenStub();
  const dir = fixtureDir(t, { 'a.proto': A_PROTO, 'agg.proto': 'syntax = "proto3";\nimport "a.proto";\n' });
  setWorkspaceFolders([dir]);
  register(dir);
  await vscode.commands.executeCommand('protoUtils.generateTypes', Uri.file(path.join(dir, 'agg.proto')));
  assert.ok(stubMessages.some((m) => m.kind === 'info' && m.message.includes('nothing to generate')));
  assert.ok(!fs.existsSync(path.join(dir, 'generated', 'agg.ts')));
});