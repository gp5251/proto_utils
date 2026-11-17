import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ProjectConfig, SETTINGS_FILE } from '../projectConfig';
import { SEQUENCE_DIR, type SequenceStoreFs } from '../runner/sequenceStore';

/** 内存 fs 替身:files 键为绝对路径。 */
function memFs(files: Record<string, string> = {}): SequenceStoreFs & { files: Record<string, string> } {
  return {
    files,
    readFile: async (f) => {
      if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[f];
    },
    writeFile: async (f, d) => void (files[f] = String(d)),
    mkdir: async () => undefined,
    rename: async (f, t) => { files[t] = files[f]; delete files[f]; },
  };
}

const ROOT = path.resolve('/ws');
const FILE = path.join(ROOT, SEQUENCE_DIR, SETTINGS_FILE);

test('缺失文件 → get 全 undefined,无 error(正常空态)', async () => {
  const pc = new ProjectConfig(ROOT, memFs());
  await pc.reload();
  assert.equal(pc.error, undefined);
  assert.equal(pc.get('runner.timeoutMs'), undefined);
});

test('坏 JSON → error 记录,缓存为空', async () => {
  const pc = new ProjectConfig(ROOT, memFs({ [FILE]: '{oops' }));
  await pc.reload();
  assert.match(pc.error ?? '', /not valid JSON/);
  assert.equal(pc.get('runner.timeoutMs'), undefined);
});

test('顶层非对象(数组/标量)→ error 记录', async () => {
  const pc = new ProjectConfig(ROOT, memFs({ [FILE]: '[1,2]' }));
  await pc.reload();
  assert.match(pc.error ?? '', /must be an object/);
});

test('合法文件 → get 命中/未命中;值原样返回', async () => {
  const pc = new ProjectConfig(
    ROOT,
    memFs({ [FILE]: JSON.stringify({ 'runner.timeoutMs': 3000, 'scan.excludeDirs': ['third_party'] }) }),
  );
  await pc.reload();
  assert.equal(pc.get('runner.timeoutMs'), 3000);
  assert.deepEqual(pc.get('scan.excludeDirs'), ['third_party']);
  assert.equal(pc.get('codeGen.outputDir'), undefined);
});

test('reload 重读:文件修复后 error 清空', async () => {
  const fs = memFs({ [FILE]: '{oops' });
  const pc = new ProjectConfig(ROOT, fs);
  await pc.reload();
  assert.ok(pc.error);
  fs.files[FILE] = JSON.stringify({ 'runner.protoDir': 'proto' });
  await pc.reload();
  assert.equal(pc.error, undefined);
  assert.equal(pc.get('runner.protoDir'), 'proto');
});

test('ensureFile:首次写模板(模板自身是合法 JSON);已存在不覆盖', async () => {
  const fs = memFs();
  const pc = new ProjectConfig(ROOT, fs);
  const p = await pc.ensureFile();
  assert.equal(p, FILE);
  const written = fs.files[FILE];
  assert.ok(written);
  const parsed = JSON.parse(written) as Record<string, unknown>;
  // 模板值 = package.json 默认值:创建文件本身不改变任何行为
  assert.equal(parsed['runner.timeoutMs'], 15000);
  assert.equal(parsed['codeGen.outputDir'], 'generated');

  fs.files[FILE] = '{"runner.protoDir":"mine"}';
  await pc.ensureFile();
  assert.equal(fs.files[FILE], '{"runner.protoDir":"mine"}');
});

test('projectConfig reload 并发(0.3.91):迟到的旧读不得覆盖新内容', async () => {
  // 审计 H7 同族:读窗口内 get() 回退 VS Code 设置,旧读后到覆新。
  const f = memFs({ [FILE]: '{"runner.server":"old:1"}' });
  let call = 0;
  f.readFile = async (p: string) => {
    const snap = f.files[p];
    if (snap === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const delay = call++ === 0 ? 30 : 0;
    await new Promise((r) => setTimeout(r, delay));
    return snap;
  };
  const pc = new ProjectConfig(ROOT, f);
  const r1 = pc.reload();
  f.files[FILE] = '{"runner.server":"new:1"}';
  const r2 = pc.reload();
  await Promise.all([r1, r2]);
  assert.equal(pc.get('runner.server'), 'new:1');
});
