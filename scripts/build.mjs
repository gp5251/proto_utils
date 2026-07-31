import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2021',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    // 调用面独立 bundle,首次打开工作台时才由 require 载入
    external: ['vscode', './runner/index.js'],
  },
  {
    ...shared,
    entryPoints: ['src/runner/index.ts'],
    outfile: 'out/runner/index.js',
  },
  {
    ...shared,
    entryPoints: ['src/test/*.test.ts'],
    outdir: 'out/test',
    // 测试可对 vscode 耦合模块(如 SymbolIndex)用 Node 替身
    alias: { vscode: path.resolve('scripts/vscodeStub.ts') },
  },
];

// Webview 工作台静态资源:Alpine 打包进 media/runner,避免 CDN(CSP 不允许远端脚本)。
async function copyRunnerAssets() {
  await mkdir('media/runner', { recursive: true });
  await copyFile('node_modules/alpinejs/dist/cdn.min.js', 'media/runner/alpine.min.js');
}

await copyRunnerAssets();

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
