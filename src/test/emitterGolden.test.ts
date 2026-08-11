import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProtoFrontend } from '../runtime/protoFrontend';
import { emit, createTypeResolver, DEFAULT_CONFIG } from '../codegen/emitter';

// golden 来源:36 个未污染文件为旧自研 parser 管线产物(scripts/genGoldens.entry.ts,逐字节冻结);
// 以下 8 个含 proto3 optional 字段的文件曾被旧 parser 误解析成垃圾,已由基于 ProtoFrontend 的
// 新 emitter 重新生成(差异仅限 optional 字段渲染),不再是旧管线产物:
//   monitor_tbl / var_enum / var_struct / var_fb / var_fc / var_elem_table / var_funcblock_inst / var_table
// 2026-08:语料(rpc_runner/protos)演进后按新 emitter 重定基 7 个(新增字段/枚举/成员,非渲染差异):
//   error_msg / ld_prog / monitor_table(新增文件) / var_fb / var_fc / var_global / var_write_value
// 2026-08(0.3.8):emitter 契约扩展——service 生成客户端调用接口 `<Name>Client`,4 个含 service 的语料重定基:
//   communicate_interface / interface / net_interface / proj_interface

const corpusDir = path.resolve('../rpc_runner/protos');
const goldenDir = path.resolve('testdata/golden');

/** 首个不一致行(1-based),用于 diff 报告,不静默放宽。 */
function firstDiff(actual: string, expected: string): string {
  const a = actual.split('\n');
  const b = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}:\n  actual:   ${JSON.stringify(a[i])}\n  expected: ${JSON.stringify(b[i])}`;
    }
  }
  return 'identical';
}

if (!fs.existsSync(goldenDir)) {
  console.log(`[emitterGolden] ${goldenDir} 不存在:golden 为冻结基线(重建见 scripts/genHeadGoldens.entry.ts),跳过`);
} else if (!fs.existsSync(corpusDir)) {
  console.log(`[emitterGolden] 语料目录 ${corpusDir} 不存在(需要 rpc_runner 仓库与 proto_utils 同级),跳过`);
} else {
  const frontend = new ProtoFrontend([corpusDir]);
  const schema = frontend.load();
  const protoFiles = fs.readdirSync(corpusDir).filter((f) => f.endsWith('.proto')).sort();

  for (const file of protoFiles) {
    test(`golden: ${file}`, () => {
      const filePath = path.join(corpusDir, file);
      const resolver = createTypeResolver(schema, filePath, {
        workspaceRoot: corpusDir,
        outputDir: 'generated',
        pathMapping: 'package',
      });
      const actual = emit(schema, filePath, DEFAULT_CONFIG, resolver);

      const goldenPath = path.join(goldenDir, file.replace(/\.proto$/, '.ts'));
      assert.ok(fs.existsSync(goldenPath), `missing golden: ${goldenPath}`);
      const expected = fs.readFileSync(goldenPath, 'utf-8');
      assert.equal(actual, expected, `${file} 首个差异 ${firstDiff(actual, expected)}`);
    });
  }
}
