import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPackageDefinition } from '../runner/core/protoCache';

/**
 * protoCache mtime 指纹门(0.3.45):未变更的文件不得重新 loadSync,
 * 变更的文件必须自动重析——此前「全清缓存」让每次保存都重解析整棵树,
 * 扩展宿主被卡数秒到数分钟,编辑器 CodeLens 请求饿死。
 */

test('getPackageDefinition:内容变化后自动重析,无需手动清缓存', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-cache-stamp-'));
  const file = path.join(dir, 'a.proto');
  fs.writeFileSync(file, 'syntax = "proto3";\npackage p;\nservice SvcA { rpc M(A) returns (A); }\nmessage A { string id = 1; }\n');

  const def1 = getPackageDefinition(file, dir);
  assert.ok(JSON.stringify(def1).includes('SvcA'), '初载应含 SvcA');

  // 追加 SvcB(尺寸变化进指纹,规避同毫秒 mtime 粒度)
  fs.writeFileSync(
    file,
    'syntax = "proto3";\npackage p;\nservice SvcA { rpc M(A) returns (A); }\nservice SvcB { rpc N(B) returns (B); }\nmessage A { string id = 1; }\nmessage B { string id = 1; }\n',
  );
  const def2 = getPackageDefinition(file, dir);
  assert.ok(JSON.stringify(def2).includes('SvcB'), '指纹失配必须重析');
  assert.notEqual(def1, def2, '新解析应产出新对象');

  // 未变化的再次调用回到缓存恒等
  assert.equal(getPackageDefinition(file, dir), def2);
});
