import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * l10n 守护:src 下所有 vscode.l10n.t('...') 源串必须出现在 zh-cn 翻译包中,
 * 反之翻译包不得残留源码已删除的键——防新串忘翻/旧串滞留。
 * webview 的 boot.strings 同样走 l10n.t(webviewHtml.ts),天然被覆盖。
 */

const SRC_DIRS = ['src'];
const BUNDLE_PATH = path.join('l10n', 'bundle.l10n.zh-cn.json');

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'test') collectSourceFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
}

function extractL10nKeys(source: string): string[] {
  const keys: string[] = [];
  const re = /l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    // 还原 TS 字符串字面量转义(\' \\ \n 等),JSON 键以真实字符为准
    keys.push(JSON.parse(`"${m[1].replace(/"/g, '\\"')}"`) as string);
  }
  return keys;
}

test('package.json 声明 l10n 目录(缺失时 vscode.l10n 静默回退英文)', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { l10n?: string };
  assert.equal(pkg.l10n, './l10n');
});

test('zh-cn 翻译包覆盖全部 l10n.t 源串且无滞留键', () => {
  const files: string[] = [];
  for (const dir of SRC_DIRS) collectSourceFiles(dir, files);
  const used = new Set<string>();
  for (const file of files) {
    for (const key of extractL10nKeys(fs.readFileSync(file, 'utf8'))) used.add(key);
  }
  assert.ok(used.size > 30, `l10n 源串扫描失效?仅 ${used.size} 条`);

  const bundle = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8')) as Record<string, unknown>;
  const translated = new Set(Object.keys(bundle));

  const missing = [...used].filter((k) => !translated.has(k));
  assert.deepEqual(missing, [], `zh-cn 包缺失翻译: ${missing.join(' | ')}`);

  const stale = [...translated].filter((k) => !used.has(k));
  assert.deepEqual(stale, [], `zh-cn 包滞留键(源码已删): ${stale.join(' | ')}`);
});
