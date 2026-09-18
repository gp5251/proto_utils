import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  SequenceStore,
  SequenceStoreError,
  SEQUENCE_DIR,
  SEQUENCE_FILE,
  type SequenceStoreFs,
  type Sequence,
} from '../runner/sequenceStore';

/** 内存 fs 替身:file→内容;readFile 缺失抛 ENOENT;记录 mkdir 调用。 */
function fakeFs(initial: Record<string, string> = {}): { fs: SequenceStoreFs; files: Map<string, string>; mkdirs: string[] } {
  const files = new Map<string, string>(Object.entries(initial));
  const mkdirs: string[] = [];
  return {
    files,
    mkdirs,
    fs: {
      async readFile(file) {
        if (!files.has(file)) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return files.get(file)!;
      },
      async writeFile(file, data) {
        files.set(file, data);
      },
      async mkdir(dir) {
        mkdirs.push(dir);
      },
    },
  };
}

const ROOT = '/ws';
const FILE = path.join(ROOT, SEQUENCE_DIR, SEQUENCE_FILE);
const DIR = path.join(ROOT, SEQUENCE_DIR);

function store(initial: Record<string, string> = {}) {
  const f = fakeFs(initial);
  return { s: new SequenceStore(ROOT, f.fs), ...f };
}

const sample: Sequence = {
  name: 'login-flow',
  steps: [
    { service: 'Auth', method: 'Login', mode: 'form', values: { user: 'a' }, responseStream: false },
    { service: 'Auth', method: 'Watch', mode: 'json', jsonText: '{}', responseStream: true },
  ],
};

test('list:文件缺失 → 空列表(不抛)', async () => {
  const { s } = store();
  assert.deepEqual(await s.list(), []);
});

test('save 后 list/get 取回;写入前 mkdir 目录', async () => {
  const { s, mkdirs, files } = store();
  await s.save(sample);
  assert.deepEqual(mkdirs, [DIR], '写前建目录');
  assert.ok(files.has(FILE));
  assert.deepEqual(await s.list(), [sample]);
  assert.deepEqual(await s.get('login-flow'), sample);
  assert.equal(await s.get('nope'), null);
});

test('save 同名覆盖,不同名追加', async () => {
  const { s } = store();
  await s.save(sample);
  await s.save({ name: 'login-flow', steps: [] });
  await s.save({ name: 'other', steps: [] });
  const all = await s.list();
  assert.equal(all.length, 2);
  assert.deepEqual(all.find((x) => x.name === 'login-flow')?.steps, [], '同名被覆盖');
});

test('delete:删存在返回 true 并移除;删不存在返回 false', async () => {
  const { s } = store();
  await s.save(sample);
  assert.equal(await s.delete('login-flow'), true);
  assert.deepEqual(await s.list(), []);
  assert.equal(await s.delete('login-flow'), false);
});

test('坏 JSON / 顶层非数组 → 抛 SequenceStoreError(不静默返空)', async () => {
  const bad = store({ [FILE]: '{ not json' });
  await assert.rejects(() => bad.s.list(), SequenceStoreError);
  const nonArray = store({ [FILE]: '{"a":1}' });
  await assert.rejects(() => nonArray.s.list(), SequenceStoreError);
});

test('逐条容错:坏序列/坏步剔除,好序列保留', async () => {
  const raw = [
    { name: 'ok', steps: [{ service: 'S', method: 'M', mode: 'form', responseStream: false }] },
    { noname: true, steps: [] },                       // 缺 name → 剔
    { name: 'badsteps', steps: 'nope' },               // steps 非数组 → 剔
    { name: 'partial', steps: [
      { service: 'S', method: 'M' },                   // 缺 mode/responseStream → 归一化默认
      { junk: true },                                  // 坏步 → 剔
      { service: 'X' },                                // 缺 method → 剔
    ] },
  ];
  const { s } = store({ [FILE]: JSON.stringify(raw) });
  const all = await s.list();
  assert.deepEqual(all.map((x) => x.name), ['ok', 'partial']);
  const partial = all.find((x) => x.name === 'partial')!;
  assert.equal(partial.steps.length, 1, '坏步被剔');
  assert.equal(partial.steps[0].mode, 'form', 'mode 默认 form');
  assert.equal(partial.steps[0].responseStream, false, 'responseStream 默认 false');
});

test('save 非法序列(缺 name)→ 抛 SequenceStoreError', async () => {
  const { s } = store();
  await assert.rejects(() => s.save({ name: '', steps: [] }), SequenceStoreError);
});

test('filePath 指向 .proto-utils/sequences.json', () => {
  const { s } = store();
  assert.equal(s.filePath, FILE);
  assert.equal(SEQUENCE_FILE, 'sequences.json');
});

test('步级 metadata/maxMessages 持久化往返(0.3.64):坏条目剔除,全空/负数不写字段', async () => {
  const { s } = store();
  await s.save({
    name: 'md',
    steps: [
      {
        service: 'S', method: 'M', mode: 'form', responseStream: false,
        metadata: [{ key: 'a', value: '1' }, { junk: true }, { key: 2, value: 'x' }],
        maxMessages: 7.8,
      },
      { service: 'S', method: 'M2', mode: 'form', responseStream: true, metadata: [], maxMessages: -1 },
    ],
  } as unknown as Sequence);
  const all = await s.list();
  const st0 = all[0].steps[0];
  assert.deepEqual(st0.metadata, [{ key: 'a', value: '1' }], '坏条目逐条剔除');
  assert.equal(st0.maxMessages, 7, '小数向下取整');
  const st1 = all[0].steps[1];
  assert.equal(st1.metadata, undefined, '全空不写字段(旧文件兼容)');
  assert.equal(st1.maxMessages, undefined, '负数不写');
});
