// golden 恢复入口:全部走 scripts/headsrc(git HEAD 的旧 parser+emitter+SymbolIndex 快照)。
// 由 scripts/gen-goldens.mjs 以 entryPoints 指到本文件来打包执行。
import fs from 'node:fs';
import path from 'node:path';
import { setCorpusRoot, Uri } from './vscodeStub';
import type { StubUri } from './vscodeStub';
import { SymbolIndex } from './headsrc/index/symbolIndex';
import { parse } from './headsrc/parser/parser';
import { emit, DEFAULT_CONFIG, TypeResolver } from './headsrc/codegen/emitter';

const corpus = process.argv[2];
const outDir = process.argv[3];
if (!corpus || !outDir) throw new Error('usage: genHeadGoldens <corpusDir> <outDir>');

setCorpusRoot(corpus);

// 与 HEAD 版 src/codegen/command.ts 的 buildResolver 逐字一致(HEAD FileEntry 含 file.package)。
function buildResolver(fromUri: StubUri, workspaceRoot: string, index: SymbolIndex): TypeResolver {
  const pathMapping = 'package';

  return (typeName: string): string | null => {
    const resolved = index.resolve(typeName, fromUri as never);
    if (!resolved) return null;
    if (resolved.uri.fsPath === fromUri.fsPath) return null;

    const resolvedEntry = index.getFile(resolved.uri);
    if (!resolvedEntry) return null;

    let targetRel: string;
    if (pathMapping === 'package' && resolvedEntry.file.package) {
      targetRel = resolvedEntry.file.package.name.replace(/\./g, '/') + '.ts';
    } else {
      targetRel = path.relative(workspaceRoot, resolved.uri.fsPath).replace(/\.proto$/, '.ts');
    }

    const fromEntry = index.getFile(fromUri as never);
    let fromRel: string;
    if (pathMapping === 'package' && fromEntry?.file.package) {
      fromRel = fromEntry.file.package.name.replace(/\./g, '/') + '.ts';
    } else {
      fromRel = path.relative(workspaceRoot, fromUri.fsPath).replace(/\.proto$/, '.ts');
    }

    const fromDir = path.dirname(fromRel);
    let rel = path.relative(fromDir, targetRel).replace(/\\/g, '/').replace(/\.ts$/, '');
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
  };
}

async function main(): Promise<void> {
  const index = new SymbolIndex();
  await index.build();

  const failures: string[] = [];
  let written = 0;
  for (const file of fs.readdirSync(corpus).filter((f) => f.endsWith('.proto')).sort()) {
    const fsPath = path.join(corpus, file);
    try {
      const source = fs.readFileSync(fsPath, 'utf-8');
      const ast = parse(source);
      const resolver = buildResolver(Uri.file(fsPath), corpus, index);
      const output = emit(ast, DEFAULT_CONFIG, resolver);
      fs.writeFileSync(path.join(outDir, file.replace(/\.proto$/, '.ts')), output);
      written++;
    } catch (err) {
      failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  fs.writeFileSync(path.join(outDir, '_failed.txt'), failures.join('\n') + (failures.length ? '\n' : ''));
  console.log(`golden: ${written} written, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
}

void main();
