// 生成 emitter 的 golden 文件:语料 = ../rpc_runner/protos(真实 25 个 proto)。
// 用法: node scripts/gen-goldens.mjs
// 产物: testdata/golden/*.ts(gitignored,业务语料不进仓库)
import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const corpus = path.resolve('../rpc_runner/protos');
if (!fs.existsSync(corpus)) {
  console.error(`语料目录不存在: ${corpus}(需要 rpc_runner 仓库与 proto_utils 同级)`);
  process.exit(1);
}

const outDir = path.resolve('testdata/golden');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const entry = process.argv.includes('--head') ? 'scripts/genHeadGoldens.entry.ts' : 'scripts/genGoldens.entry.ts';

const bundle = path.resolve('out/golden-gen.cjs');
await esbuild.build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2021',
  alias: { vscode: path.resolve('scripts/vscodeStub.ts') },
  logLevel: 'warning',
});

process.argv = [process.argv[0], bundle, corpus, outDir];
await import(pathToFileURL(bundle).href);
