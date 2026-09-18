import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { escapeInlineJson, generateNonce, renderWorkbenchHtml } from '../runner/webviewHtml';
import type { ServicesPayload } from '../runner/serviceRegistry';

const baseOptions = {
  cspSource: 'vscode-webview://test',
  stylesUri: 'vscode-webview://test/runner.css',
  runnerScriptUri: 'vscode-webview://test/runner.js',
  formMappingScriptUri: 'vscode-webview://test/formMapping.js',
  resultTreeScriptUri: 'vscode-webview://test/resultTree.js',
  placeholderScriptUri: 'vscode-webview://test/placeholder.js',
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
  // 0.3.62 刷新拆分:「刷新服务」仅探测 / 「刷新 proto」才重解析,双按钮文案与状态绑定须区分
  assert.ok(html.includes('@click="refreshServices()"'), '缺刷新服务按钮');
  assert.ok(html.includes('Refresh proto') && html.includes('Refresh services'), '两个刷新按钮文案须区分');
  assert.ok(html.includes('$store.workbench.probingServices'), '刷新服务按钮须绑定 probingServices');
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

test('prefill miss 反馈锚点:通知卡片 + host 文案 + services 到达即清', () => {
  const html = render();
  assert.ok(html.includes('$store.workbench.prefillNotice'), '缺 miss 通知展示槽');
  // host 文案在 TS 源里(boot.strings 下发),渲染产物只含译文值
  const tsSrc = fs.readFileSync(path.resolve('src/runner/webviewHtml.ts'), 'utf8');
  assert.ok(tsSrc.includes('prefillMiss: l10n.t('), 'host 侧必须下发 prefillMiss 文案');
});

test('顶栏连接状态点(0.3.54):绑定 connState 三态,不可达提示文案进 boot.strings', () => {
  const html = render();
  // 状态点颜色走 :class 绑定(unknown=灰/ok=绿/fail=红),不再是静态绿点
  assert.ok(html.includes('class="dot" :class="$store.workbench.connState"'), '状态点必须绑定 connState');
  assert.ok(html.includes("$store.workbench.connState === 'fail'"), '缺不可达提示的显隐门控');
  assert.ok(html.includes('connUnreachable'), '缺不可达文案键');
  assert.ok(html.includes('Server unreachable'), 'boot.strings 缺不可达文案值');
});

test('不可达禁发(0.3.54):发送按钮 disabled 含 connState fail,就地提示复用 unsupported-hint', () => {
  const html = render();
  assert.ok(
    html.includes(":disabled=\"isLoading(svcId(svc), m.name) || m.requestStream || $store.workbench.connState === 'fail'\""),
    '发送按钮 disabled 必须含 connState fail 条件',
  );
  // 提示与按钮同容器,复用 unsupported-hint 样式(CSS 零改动)
  assert.ok(
    html.includes('x-show="$store.workbench.connState === \'fail\'" class="unsupported-hint" x-text="$store.str.svcUnavailable"'),
    '缺不可达就地提示槽',
  );
  assert.ok(html.includes('Service unavailable'), 'boot.strings 缺禁发提示文案值');
  // 0.3.57:跃迁瞬时提醒文案
  assert.ok(html.includes('Connection restored') && html.includes('Connection lost'), 'boot.strings 缺跃迁提醒文案');
});

test('x-show 与 :style 不得同元素:services 重推后 :style 字符串重赋值会抹掉 x-show 的 display:none(空白行回归守卫)', () => {
  const html = render();
  // 抓所有开标签(含跨行),任何元素同时带 x-show 与 :style 即违规
  const tags = html.match(/<[a-z]+[^>]*>/gs) ?? [];
  const violations = tags.filter((t) => /x-show=/.test(t) && /:style=/.test(t));
  assert.deepStrictEqual(violations, [], `以下元素同时携带 x-show 与 :style:\n${violations.join('\n')}`);
  // 修复后的可见性门控:display:none 由 :style 三元式 false 分支给出
  assert.ok(html.includes(`? 'padding-left:' + (row.depth * 14) + 'px' : 'display: none'`), 'field-group 的 kind 门控应折进 :style');
  assert.ok(html.includes(`? 'margin-bottom: 10px; padding-left:' + (row.depth * 14 + 24) + 'px' : 'display: none'`), '请求嵌套 schema-block 的展开门控应折进 :style');
});

test('序列视图锚点(0.3.59):视图切换/加入序列/运行控制/报告 + placeholder.js 先于 runner.js', () => {
  const html = render();
  assert.ok(html.includes('src="vscode-webview://test/placeholder.js"'));
  assert.ok(html.indexOf('placeholder.js') < html.indexOf('runner.js'), 'placeholder.js 必须在 runner.js 之前加载');
  assert.ok(html.includes('class="view-tabs"'), '缺视图切换 tab 条');
  assert.ok(html.includes("setView('sequence')"), '缺切到序列视图入口');
  assert.ok(html.includes('addToSequence(svc, m)'), '方法行缺“加入序列”按钮');
  for (const anchor of [
    'runSequence()', 'stopSequence()', 'saveSequence()', 'endSeqStream()',
    'seqReportEntries()', 'hasSeqReport()', 'stepRefProblems(step, sIdx)',
    'loadSequence(s.name)', 'deleteSequence(s.name)',
    "$store.workbench.view === 'sequence'",
  ]) {
    assert.ok(html.includes(anchor), `缺序列锚点: ${anchor}`);
  }
  // 序列枚举 select 必须 option 级 :selected(预填值在 options 渲染前赋值会被丢弃,0.3.62)
  assert.ok(html.includes(':selected="getFieldValue(step.id, row.path) === ev.name"'), '序列枚举缺 option 级 :selected');
  assert.ok(html.includes(':selected="!getFieldValue(step.id, row.path)"'), '序列枚举占位 option 缺 :selected');
  // 常驻控件条上的「结束并继续」(报告行内按钮随 chunk 重渲染可能吞点击,0.3.62)
  assert.ok(html.includes('x-show="seqHasRunningStream()"'), '缺常驻控件条的结束并继续按钮');
  // 0.3.62 停止反馈:停止/结束按钮绑定 seqStopping 禁用并换「正在停止…」文案
  assert.ok(html.includes(':disabled="seqStopping"'), '停止/结束按钮须绑定 seqStopping 禁用');
  assert.ok(html.includes('Stopping…'), '缺正在停止文案');
  // 序列内二级 tab(0.3.62):步骤/报告分容器 + 报告空态 + 复制报告移入报告 tab
  assert.ok(html.includes("seqTab === 'steps'") && html.includes("seqTab === 'report'"), '缺序列二级 tab 门控');
  assert.ok(html.includes("setSeqTab('report')"), '缺切到报告 tab 入口');
  assert.ok(html.includes('x-show="!hasSeqReport()"'), '缺运行报告空态');
  // 0.3.64 步级 metadata 覆盖 + 步级/服务页流接收上限 + capped 完成态(全局 seqStreamChunkLimit 已移除)
  assert.ok(html.includes('getHeaders(step.id, true)'), '序列步级 Headers 覆盖编辑器须不初始化全局');
  assert.ok(html.includes('seqMaxMsgs[step.id]'), '序列步级缺最大消息数输入');
  assert.ok(html.includes('setSeqMaxMsgs(step.id, $event.target.value)'), '上限输入须走组件方法(@alpinejs/csp 不支持内联赋值)');
  assert.ok(!html.includes('seqMaxMsgs = Object.assign'), '模板不得内联 Object.assign 赋值(CSP 求值器不生效)');
  assert.ok(html.includes('seqMaxMsgs[methodKey(svcId(svc), m.name)]'), '服务页流方法缺最大消息数输入');
  assert.ok(html.includes('streamIsCapped('), '缺收满自动停的完成态判定');
  assert.ok(html.includes('seqChunkCountText(entry)'), '报告行缺 chunk 计数');
  // 0.3.67 回到顶部浮动按钮
  assert.ok(html.includes('class="back-top"'), '缺回到顶部浮动按钮');
  assert.ok(html.includes('@click="backToTop()"'), '回到顶部按钮缺点击绑定');
  assert.ok(html.includes('x-show="$store.workbench.backTop"'), '回到顶部按钮须受滚动阈值门控');
  // 0.3.63 步骤入参默认折叠:入参区 x-show 折叠态 + 标题/图标可切换 + 占位符告警在折叠外
  assert.ok(html.includes('x-show="isSeqStepOpen(step.id)"'), '步骤入参区须受折叠态门控');
  assert.ok(html.includes('@click="toggleSeqStep(step.id)"'), '缺步骤折叠切换入口');
});
