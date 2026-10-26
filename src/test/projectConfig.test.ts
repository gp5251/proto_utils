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
