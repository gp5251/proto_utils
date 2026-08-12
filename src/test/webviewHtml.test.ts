import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeInlineJson, generateNonce, renderWorkbenchHtml } from '../runner/webviewHtml';
import type { ServicesPayload } from '../runner/serviceRegistry';

const baseOptions = {
  cspSource: 'vscode-webview://test',
  stylesUri: 'vscode-webview://test/runner.css',
  runnerScriptUri: 'vscode-webview://test/runner.js',
  formMappingScriptUri: 'vscode-webview://test/formMapping.js',
  alpineScriptUri: 'vscode-webview://test/alpine.min.js',
  server: 'localhost:50051',
  protoDir: 'D:/work/protos',
};

function render(extra: Partial<Parameters<typeof renderWorkbenchHtml>[0]> = {}): string {
  return renderWorkbenchHtml({ nonce: generateNonce(), ...baseOptions, ...extra });
}

test('generateNonce 每次生成不同的 nonce', () => {
  assert.notEqual(generateNonce(), generateNonce());
});

test('nonce 同时出现在 CSP 与所有 script 标签', () => {
  const nonce = generateNonce();
  const html = render({ nonce });
  assert.ok(html.includes(`script-src 'nonce-${nonce}'`));
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(tags.length >= 3, `expected >=3 script tags, got ${tags.length}`);
  for (const tag of tags) {
    assert.ok(tag.includes(`nonce="${nonce}"`), `script tag missing nonce: ${tag}`);
  }
});

test('CSP: default-src none、style-src 放行 cspSource 与 unsafe-inline、无远端脚本源', () => {
  const html = render();
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("style-src vscode-webview://test 'unsafe-inline'"));
  assert.ok(!html.includes('cdn.jsdelivr.net'));
  assert.ok(!html.includes('https://'), 'CSP/资源不得引用远端 URL');
});

test('asWebviewUri 资源(样式 + formMapping.js + runner.js + alpine)均出现在 HTML', () => {
  const html = render();
  assert.ok(html.includes('href="vscode-webview://test/runner.css"'));
  assert.ok(html.includes('src="vscode-webview://test/formMapping.js"'));
  assert.ok(html.includes('src="vscode-webview://test/runner.js"'));
  assert.ok(html.includes('src="vscode-webview://test/alpine.min.js"'));
});

test('双模式编辑器锚点:Tab 条/json-editor/sendFromEditor/formMapping 先于 runner.js 加载', () => {
  const html = render();
  assert.ok(html.includes('class="editor-tabs"'));
  assert.ok(html.includes('>表单</button>'));
  assert.ok(html.includes('>JSON</button>'));
  assert.ok(html.includes('class="json-editor"'));
  assert.ok(html.includes('class="json-error"'));
  assert.ok(html.includes('class="json-warning"'));
  assert.ok(html.includes('sendFromEditor(svc.name, m.name, m)'));
  // formMapping 必须先于 runner.js:runner.js 的状态机同步调用 window.FormMapping
  assert.ok(
    html.indexOf('formMapping.js') < html.indexOf('runner.js'),
    'formMapping.js 必须在 runner.js 之前加载',
  );
});

test('内嵌 services 序列化防 </script> 注入', () => {
  const evil = '</script><script>alert(1)</script>';
  const services = [
    {
      name: evil,
      fullName: 'pkg.Evil',
      methods: [
        {
          name: 'Run',
          requestType: 'Req',
          responseType: 'Res',
          requestStream: false,
          responseStream: false,
          requestFields: [],
          responseSchemaRows: [],
        },
      ],
    },
  ] as unknown as ServicesPayload;
  const html = render({ initialServices: services });
  assert.ok(!html.includes(evil), 'raw </script> payload must not survive inlining');
  assert.ok(html.includes('\\u003c/script>'), 'escaped 序列应出现在内嵌 JSON 中');
});

test('escapeInlineJson 转义所有 <', () => {
  const json = escapeInlineJson({ a: '<b>', c: ['<<'] });
  assert.ok(!json.includes('<'));
  const parsed: { a: string } = JSON.parse(json);
  assert.equal(parsed.a, '<b>');
});

test('boot 数据内嵌 server 与 protoDir', () => {
  const html = render();
  assert.ok(html.includes('window.__PROTO_UTILS_BOOT__ = '));
  assert.ok(html.includes('localhost:50051'));
  assert.ok(html.includes('D:/work/protos'));
});

test('loading 态:加载卡片与 spinner 标记', () => {
  const html = render();
  assert.ok(html.includes('id="proto-loading-card"'));
  assert.ok(html.includes('proto-loading-spinner'));
  assert.ok(html.includes('正在解析 proto 文件'));
});

test('错误态:错误卡片标记与 errors 渲染', () => {
  const html = render();
  assert.ok(html.includes('id="proto-error-card"'));
  assert.ok(html.includes('Proto 加载错误'));
  assert.ok(html.includes('$store.workbench.errors'));
});

test('空态:未找到服务与无匹配结果两种标记', () => {
  const html = render();
  assert.ok(html.includes('未找到服务'));
  assert.ok(html.includes('无匹配结果'));
  assert.ok(html.includes('empty-state'));
});

test('交互结构:搜索、刷新按钮、流式徽标、取消按钮、prefill 锚点 id', () => {
  const html = render();
  assert.ok(html.includes('x-model="$store.search.query"'));
  // 刷新走 Alpine.data 组件方法(csp Alpine 见不到 window 全局,postRefresh 入口已移除)
  assert.ok(html.includes('x-data="pageMeta"'));
  assert.ok(html.includes('@click="refresh()"'));
  assert.ok(html.includes("$store.workbench.refreshing"));
  assert.ok(html.includes('method-stream-badge'));
  assert.ok(html.includes('cancelStream(svc.name, m.name)'));
  assert.ok(html.includes(":id=\"'method-' + svc.name + '-' + m.name\""));
  assert.ok(html.includes('requestStream'), 'client/bidi 方法禁用提示');
});
