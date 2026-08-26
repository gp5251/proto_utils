import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeInlineJson, generateNonce, renderWorkbenchHtml } from '../runner/webviewHtml';
import type { ServicesPayload } from '../runner/serviceRegistry';

const baseOptions = {
  cspSource: 'vscode-webview://test',
  stylesUri: 'vscode-webview://test/runner.css',
  runnerScriptUri: 'vscode-webview://test/runner.js',
  formMappingScriptUri: 'vscode-webview://test/formMapping.js',
  resultTreeScriptUri: 'vscode-webview://test/resultTree.js',
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

test('asWebviewUri 资源(样式 + formMapping.js + resultTree.js + runner.js + alpine)均出现在 HTML', () => {
  const html = render();
  assert.ok(html.includes('href="vscode-webview://test/runner.css"'));
  assert.ok(html.includes('src="vscode-webview://test/formMapping.js"'));
  assert.ok(html.includes('src="vscode-webview://test/resultTree.js"'));
  assert.ok(html.includes('src="vscode-webview://test/runner.js"'));
  assert.ok(html.includes('src="vscode-webview://test/alpine.min.js"'));
});

test('双模式编辑器锚点:Tab 条/json-editor/sendFromEditor/formMapping 先于 runner.js 加载', () => {
  const html = render();
  assert.ok(html.includes('class="editor-tabs"'));
  assert.ok(html.includes('>Form</button>'));
  assert.ok(html.includes('>JSON</button>'));
  assert.ok(html.includes('class="json-editor"'));
  assert.ok(html.includes('class="json-error"'));
  assert.ok(html.includes('class="json-warning"'));
  assert.ok(html.includes('sendFromEditor(svcId(svc), m.name, m)'));
  // formMapping 必须先于 runner.js:runner.js 的状态机同步调用 window.FormMapping
  assert.ok(
    html.indexOf('formMapping.js') < html.indexOf('runner.js'),
    'formMapping.js 必须在 runner.js 之前加载',
  );
  // resultTree 同约:runner.js 折叠树方法同步调用 window.ResultTree
  assert.ok(
    html.indexOf('resultTree.js') < html.indexOf('runner.js'),
    'resultTree.js 必须在 runner.js 之前加载',
  );
});

test('响应 metadata 折叠块锚点:一元/流式结果区各一份,标题与行标签串进 boot', () => {
  const html = render();
  assert.equal(html.match(/class="resp-meta"/g)?.length, 2);
  assert.ok(html.includes('hasRespMeta(svcId(svc), m.name)'));
  assert.ok(html.includes('toggleRespMeta(svcId(svc), m.name)'));
  assert.ok(html.includes('respMetaEntries(svcId(svc), m.name)'));
  assert.ok(html.includes('Response metadata'));
  assert.ok(html.includes('respMetaHeader'));
  assert.ok(html.includes('respMetaTrailer'));
});

test('响应折叠树锚点:一元/流式各一份树 + 原始 pre 兜底;chunk 折叠条与树方法齐备', () => {
  const html = render();
  assert.equal(html.match(/class="result-body result-tree"/g)?.length, 1, '一元树恰好 1 处');
  assert.equal(html.match(/class="stream-tree"/g)?.length, 1, '流式树恰好 1 处');
  // 原始 <pre> 兜底仍在(错误/空流路径),一元与流式各 1
  assert.equal(html.match(/class="result-body"/g)?.length, 2);
  for (const anchor of [
    'resultTreeAvailable(svcId(svc), m.name)',
    'resultTreeRows(svcId(svc), m.name)',
    'toggleTreeNode(svcId(svc), m.name, row.path)',
    'streamIsTreeable(svcId(svc), m.name)',
    'chunkSections(svcId(svc), m.name)',
    'chunkTreeRows(svcId(svc), m.name, sec.idx)',
    'toggleChunkTree(svcId(svc), m.name, sec.idx)',
    'tree-value-',
    // 0.3.42:全部展开/收起按钮(一元 + 流式各一对)
    'expandAllResult(svcId(svc), m.name)',
    'collapseAllResult(svcId(svc), m.name)',
    'expandAllChunks(svcId(svc), m.name)',
    'collapseAllChunks(svcId(svc), m.name)',
  ]) {
    assert.ok(html.includes(anchor), `缺少锚点: ${anchor}`);
  }
  assert.ok(html.includes('Expand all'));
  assert.ok(html.includes('Collapse all'));
  assert.equal(html.match(/Expand all/g)?.length, 2, '一元与流式各一个全部展开');
  assert.equal(html.match(/Collapse all/g)?.length, 2, '一元与流式各一个全部收起');
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

test('Headers 编辑器:行编辑锚点 + metadataDefault 注入 boot', () => {
  const html = render({ metadataDefault: [{ key: 'authorization', value: 'Bearer t' }] });
  assert.ok(html.includes('class="headers-editor"'));
  assert.ok(html.includes('addHeaderRow(methodKey(svcId(svc), m.name))'));
  assert.ok(html.includes('removeHeaderRow(methodKey(svcId(svc), m.name), hIdx)'));
  assert.ok(html.includes('setHeaderField(methodKey(svcId(svc), m.name), hIdx'));
  assert.ok(html.includes('"metadata":[{"key":"authorization","value":"Bearer t"}]'));
  // 缺省为空数组
  assert.ok(render().includes('"metadata":[]'));
});

test('loading 态:加载卡片与 spinner 标记', () => {
  const html = render();
  assert.ok(html.includes('id="proto-loading-card"'));
  assert.ok(html.includes('proto-loading-spinner'));
  assert.ok(html.includes('Parsing proto files'));
});

test('错误态:错误卡片标记与 errors 渲染', () => {
  const html = render();
  assert.ok(html.includes('id="proto-error-card"'));
  assert.ok(html.includes('Proto Load Errors'));
  assert.ok(html.includes('$store.workbench.errors'));
  // 0.3.40:出错点分段渲染(spot 段波浪线,x-text 结构化转义)
  assert.ok(html.includes('$store.workbench.errorSegs[eIdx]'));
  assert.ok(html.includes('seg.text'));
  assert.ok(html.includes('error-spot'));
});

test('空态:未找到服务与无匹配结果两种标记', () => {
  const html = render();
  assert.ok(html.includes('No services found'));
  assert.ok(html.includes('No matching results'));
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
  assert.ok(html.includes('copyServiceName(svc)'), '服务名旁复制 icon');
  assert.ok(html.includes('isServiceCopied(svc)'), '服务名复制反馈');
  assert.ok(html.includes('cancelStream(svcId(svc), m.name)'));
  assert.ok(html.includes(":id=\"'method-' + svcId(svc) + '-' + m.name\""));
  assert.ok(html.includes('requestStream'), 'client/bidi 方法禁用提示');
});

test('表单校验反馈锚点:发送前错误槽 + bytes 专用 base64 输入分支', () => {
  const html = render();
  assert.ok(
    html.includes('getFormError(methodKey(svcId(svc), m.name))'),
    '发送按钮区必须有表单问题清单展示槽',
  );
  assert.ok(html.includes("row.field.protoType === 'TYPE_BYTES'"), '缺 bytes 专用输入分支');
  assert.ok(html.includes("row.field.protoType !== 'TYPE_BYTES'"), '通用文本分支必须排除 BYTES');
  assert.ok(html.includes('Base64-encoded value'), 'bytes 提示文案(host 侧 l10n 源串)');
});
