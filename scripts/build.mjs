import * as esbuild from 'esbuild';
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
  { ...shared, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js' },
  {
    ...shared,
    entryPoints: ['src/test/*.test.ts'],
    outdir: 'out/test',
    // 测试可对 vscode 耦合模块(如 SymbolIndex)用 Node 替身
    alias: { vscode: path.resolve('scripts/vscodeStub.ts') },
  },
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
