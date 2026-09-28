import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * media/runner/runner.js 是手写 media 代码,无 Alpine 夹具可测(仓库既定)。
 * 0.3.41 曾发生错位编辑吞行:applyCallResult 丢了 var key/setResult,
 * 发送后 loading 永不复位(语法合法,测试与打包全绿,浏览器才炸)。
 * 此文件是这类损伤的最小守卫:语法解析 + 关键调用顺序。
 */

const RUNNER_JS = path.resolve('media/runner/runner.js');

test('media/runner/runner.js 语法可解析', () => {
  // new Function 只解析不执行
  new Function(fs.readFileSync(RUNNER_JS, 'utf8'));
});

test('applyCallResult:先定义 key/setResult,再建树,再复位 loading', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('applyCallResult: function');
  assert.ok(start >= 0, '缺 applyCallResult');
  const end = src.indexOf('applyStreamMeta: function', start);
  const body = src.slice(start, end);
  const order = {
    'var key 定义': body.indexOf('var key = this.methodKey'),
    'setResult': body.indexOf('this.setResult(key, payload)'),
    '建树': body.indexOf('window.ResultTree.buildResultTree'),
    'loading 复位': body.indexOf('this.setLoading(key, false)'),
  };
  for (const [name, idx] of Object.entries(order)) {
    assert.ok(idx >= 0, `applyCallResult 缺「${name}」`);
  }
  assert.ok(order['var key 定义'] < order['建树'], '建树前必须定义 key');
  assert.ok(order['setResult'] < order['建树'], '建树前必须存结果');
  assert.ok(order['建树'] < order['loading 复位'], '建树在 loading 复位之前(失败路径应清树)');
});

test('服务身份用 svcId(fullName):跨包同短名服务的状态与消息路由不串线', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  // 身份助手存在
  assert.ok(src.includes('svcId: function'), '缺 svcId 助手');

  // openMethod 的展开态/methodKey/DOM 锚点全部走身份而非显示短名
  const openStart = src.indexOf('openMethod: function');
  const openEnd = src.indexOf('ensureFormValues: function', openStart);
  const openBody = src.slice(openStart, openEnd);
  assert.ok(openBody.includes('var id = this.svcId(svc)'), 'openMethod 必须先算身份 id');
  assert.ok(!openBody.includes('methodKey(svc.name'), 'openMethod 的 methodKey 不得用短名');

  // 复制徽标态按身份记,剪贴板仍复制显示短名
  assert.ok(src.includes('copyServiceName: function (svc)'), 'copyServiceName 应接收服务对象');

  // 模板侧(webviewHtml.ts):卡片 key 与所有身份调用点走 svcId
  const htmlSrc = fs.readFileSync(path.resolve('src/runner/webviewHtml.ts'), 'utf8');
  assert.ok(htmlSrc.includes(':key="svcId(svc)"'), '服务卡片 x-for key 必须用 svcId(svc)');
  assert.ok(!htmlSrc.includes('toggleService(svc.name'), '模板身份调用点不得再传短名 svc.name');
});

test('流式发送态:startStream 置 loading,applyStreamEnd/applyCallResult 复位', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const sStart = src.indexOf('startStream: function');
  const sEnd = src.indexOf('cancelStream: function', sStart);
  const sBody = src.slice(sStart, sEnd);
  assert.ok(sStart >= 0 && sEnd > sStart, '缺 startStream');
  // 0.3.70 起经 markLoading(key) 置位(内部即 setLoading(key, true) + 起计时器)
  assert.ok(
    sBody.includes('this.setLoading(key, true)') || sBody.includes('this.markLoading(key)'),
    'startStream 必须置 loading(按钮发送中态)',
  );

  const eStart = src.indexOf('applyStreamEnd: function');
  const eEnd = src.indexOf('getStreamBody: function', eStart);
  const eBody = src.slice(eStart, eEnd);
  assert.ok(eStart >= 0 && eEnd > eStart, '缺 applyStreamEnd');
  assert.ok(eBody.includes('this.setLoading(key, false)'), 'applyStreamEnd 必须复位 loading(流结束/取消)');
  // 出错路径:host onError 发 callResult,复位已在 applyCallResult 守卫覆盖
});

test('applyLoadError 空消息守卫:空串错误/空文本 segments 不得渲染空白红卡', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('function applyLoadError');
  const end = src.indexOf('var noticeTimer', start);
  const body = src.slice(start, end);
  assert.ok(start >= 0 && end > start, '缺 applyLoadError');
  assert.ok(body.includes('segText.trim()'), '必须检测 segments 拼接文本为空');
  assert.ok(body.includes("str('emptyLoadError')"), '空消息必须兜底为可见文案');
  assert.ok(src.includes('emptyLoadError:'), '缺 emptyLoadError 默认串');
});

test('submitCall 入口 isLoading 早退:Enter 表单提交不得绕过发送中禁用', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('submitCall: function');
  const end = src.indexOf('startStream: function', start);
  const body = src.slice(start, end);
  assert.ok(start >= 0 && end > start, '缺 submitCall');
  assert.ok(body.includes('this.isLoading(svcName, methodName)'), 'submitCall 必须 isLoading 早退');
  assert.ok(body.indexOf('this.isLoading') < body.indexOf('sendMessage'), '早退必须在发 call 消息之前');
});

test('submitCall 不可达早退(0.3.54):connState fail 在发消息前拦下(与按钮 disabled 同契约)', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('submitCall: function');
  const end = src.indexOf('startStream: function', start);
  const body = src.slice(start, end);
  assert.ok(body.includes("connState === 'fail'"), 'submitCall 缺不可达早退');
  assert.ok(
    body.indexOf("connState === 'fail'") < body.indexOf('sendMessage'),
    '不可达早退必须在发 call 消息之前',
  );
  assert.ok(src.includes('svcUnavailable:'), '缺 svcUnavailable 默认串');
});

test('applyStreamChunk 走有界窗口(pushBounded + dropped 偏移),长流不吃内存', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('applyStreamChunk: function');
  const end = src.indexOf('applyStreamEnd: function', start);
  const body = src.slice(start, end);
  assert.ok(body.includes('ResultTree.pushBounded'), '必须经 pushBounded 有界追加');
  assert.ok(body.includes('dropped'), '必须累计 dropped 偏移(绝对序号/总量用)');
});

test('行展开态键带作用域前缀:响应区/请求嵌套schema/请求表单同路径互不串扰', () => {  const htmlSrc = fs.readFileSync(path.resolve('src/runner/webviewHtml.ts'), 'utf8');
  assert.ok(htmlSrc.includes("visibleSchemaRows(m.responseSchemaRows, 'res')"), '响应区作用域');
  assert.ok(htmlSrc.includes("toggleRow(rowKey('res', row.path))"), '响应区展开键');
  assert.ok(htmlSrc.includes("toggleRow(rowKey('reqf', row.path))"), '请求表单展开键');
  assert.ok(htmlSrc.includes("isRowOpen(rowKey('reqf', row.path))"), '请求表单可见性键');
  assert.ok(htmlSrc.includes("visibleSchemaRows(fieldSchemaRows(row.field), 'reqs')"), '请求嵌套 schema 作用域');
  assert.ok(htmlSrc.includes("toggleRow(rowKey('reqs', sRow.path))"), '请求嵌套 schema 展开键');

  const js = fs.readFileSync(RUNNER_JS, 'utf8');
  assert.ok(js.includes('rowKey: function'), '缺 rowKey 助手');
  assert.ok(/visibleSchemaRows: function \(rows, scope\)/.test(js), 'visibleSchemaRows 必须接受 scope');
});

test('sendFromEditor 发送前跑 validateFormValues,问题清单进 formErrors 展示', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('sendFromEditor: function');
  const end = src.indexOf('filteredServices: function', start);
  const body = src.slice(start, end);
  assert.ok(body.includes('FormMapping.validateFormValues'), '发送前必须校验表单值');
  assert.ok(body.includes('setFormError'), '问题清单必须写入 formErrors');

  const head = src.slice(0, start);
  assert.ok(head.includes('formErrors: {}'), '缺 formErrors 状态字典');
  assert.ok(head.includes('getFormError: function') || body.includes('getFormError'), '缺 getFormError');
});

test('prefill miss 必须可见:置 prefillNotice 并丢弃滞留,不得零反馈', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('tryApplyPrefill');
  const end = src.indexOf("document.addEventListener('alpine:init'", start);
  const body = src.slice(start, end);
  assert.ok(body.includes('openMethod(pendingPrefill.service'), '仍走 openMethod 尝试');
  assert.ok(body.includes("str('prefillMiss'"), 'miss 必须经 str(prefillMiss) 写可见通知');
  // miss 后清空滞留:否则下次 services 到达会突然跳到旧目标(H4 错位)
  assert.ok(body.indexOf('pendingPrefill = null', body.indexOf('openMethod')) > -1, 'miss 分支必须清 pendingPrefill');

  assert.ok(src.includes('prefillMiss:'), '缺 miss 文案默认串');
});

test('connState 消息路由(0.3.54):状态点 unknown 默认,host 推送后转 ok/fail', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  assert.ok(src.includes("case 'connState':"), '缺 connState 消息路由');
  assert.ok(src.includes("connState: 'unknown'"), 'store 缺 connState 默认态');
  assert.ok(src.includes('connUnreachable:'), '缺 connUnreachable 默认串');
});

test('connState 跃迁提醒(0.3.57):fail→ok 提示恢复,ok→fail 提示断开,unknown 首探不提醒', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf("case 'connState':");
  assert.ok(start >= 0, '缺 connState 消息路由');
  const body = src.slice(start, src.indexOf('break;', start));
  // 先存旧态再赋新态,两个方向各一条提醒
  assert.ok(body.includes('prevConn'), '必须先存跃迁前状态');
  assert.ok(
    body.includes("prevConn === 'fail' && nextConn === 'ok'") && body.includes("str('connRestored')"),
    'fail→ok 必须提示连接已恢复',
  );
  assert.ok(
    body.includes("prevConn === 'ok' && nextConn === 'fail'") && body.includes("str('connLost')"),
    'ok→fail 必须提示连接已断开',
  );
  // unknown 不出现在任何提醒条件里(首探不打扰)
  assert.ok(!body.includes("prevConn === 'unknown'"), 'unknown 首探不得提醒');
  assert.ok(src.includes('connRestored:') && src.includes('connLost:'), '缺跃迁文案默认串');
  // 提醒走 showNotice 瞬时通道(2.5s 自动消失),不得常驻 refreshNotice
  assert.ok(body.includes('showNotice('), '跃迁提醒必须走 showNotice');
  // 0.3.69 显隐兜底:x-show 效果不收敛时红字残留,唯一写入点命令式同步 .conn-hint
  assert.ok(body.includes("querySelector('.conn-hint')"), 'connState 写入点须命令式同步 conn-hint 显隐');
  // 0.3.62 手动「刷新服务」回执:仅手动探测才提醒,周期复探不打扰
  assert.ok(body.includes('probingServices'), '手动刷新服务回执须在 connState 路由内收尾');
  assert.ok(src.includes('refreshServices() {'), 'pageMeta 缺 refreshServices');
  // 0.3.62 停止反馈:点击立即置 seqStopping,收尾事件清除
  assert.ok(src.includes('this.seqStopping = true'), '停止/结束点击须立即置 seqStopping');
  assert.ok(src.includes('this.seqStopping = false'), '收尾事件须清除 seqStopping');
  // 0.3.64 序列流报告区有界窗口:按步 maxMessages pushBounded,防长流撑爆
  assert.ok(src.includes('ResultTree.pushBounded(rep[ev.index].chunks'), '序列报告 chunk 须走 pushBounded 有界窗口');
  // 0.3.64 服务页流方法收满自动停:取消流并按完成态展示
  assert.ok(src.includes('streamCapReached'), '缺收满自动停的通知文案键');
});

test('加入序列(0.3.66):不切视图,仅瞬时提示已加入', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('addToSequence: function');
  const end = src.indexOf('removeStep: function', start);
  assert.ok(start >= 0 && end > start, '缺 addToSequence');
  const body = src.slice(start, end);
  assert.ok(!body.includes("view = 'sequence'"), '加入序列不得立即切换视图');
  assert.ok(body.includes("str('seqAdded'"), '加入序列须弹瞬时提示');
});

test('回到顶部(0.3.67):滚动阈值监听 + backToTop 方法齐备', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  assert.ok(src.includes('BACK_TOP_THRESHOLD'), '缺滚动阈值常量');
  assert.ok(src.includes("addEventListener('scroll'"), '缺滚动监听');
  assert.ok(src.includes('backToTop: function'), '缺 backToTop 方法');
  assert.ok(src.includes('backTop: false'), 'store 缺 backTop 初始态');
});

test('过滤命中面(0.3.58):fullName 只收子串/单段模糊,跨段散字子序列不得命中', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  // 提取 fuzzyMatch + matchServiceName 同源实跑(两函数相邻,位于 postMessage 注释块之前)
  const start = src.indexOf('function fuzzyMatch');
  const end = src.indexOf('// webview postMessage', start);
  assert.ok(start >= 0 && end > start, '缺 fuzzyMatch/matchServiceName 函数块');
  const impl = new Function(`${src.slice(start, end)}; return { fuzzyMatch, matchServiceName };`)() as {
    fuzzyMatch(q: string, t: string): boolean;
    matchServiceName(q: string, svc: { name: string; fullName?: string }): boolean;
  };
  const svc = { name: 'AutoShopCommunicateService', fullName: 'autoshop.project.v1.AutoShopCommunicateService' };
  // 实证 bug:trace 跨段散字命中包限定名 → 全服务命中、过滤看似无效
  assert.equal(impl.matchServiceName('trace', svc), false, 'trace 不得跨段散字命中 fullName');
  // 包名检索能力保留:含点子串 + 段内模糊
  assert.equal(impl.matchServiceName('project.v1', svc), true, '含点包名子串必须命中');
  assert.equal(impl.matchServiceName('prj', svc), true, '段内模糊(project→prj)必须命中');
  // 短名与方法名仍走模糊
  assert.equal(impl.matchServiceName('trace', { name: 'TraceGraph', fullName: 'x.y.TraceGraph' }), true, '短名模糊必须保留');
  assert.equal(impl.fuzzyMatch('trace', 'ClickEnter'), false, '方法名模糊基线');

  // 模板侧两个过滤函数必须走 matchServiceName,不得再对 fullName 整串跑 fuzzy
  const fsStart = src.indexOf('filteredServices: function');
  const fmEnd = src.indexOf('toggleService: function', fsStart);
  const body = src.slice(fsStart, fmEnd);
  assert.ok(body.includes('matchServiceName(q, svc)'), 'filteredServices/filteredMethods 必须走 matchServiceName');
  assert.ok(!body.includes('fuzzyMatch(q, svc.fullName)'), '不得再对 fullName 整串跑跨段模糊');
});

test('序列消息路由与组件方法(0.3.59)齐备', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  for (const c of ["case 'seqEvent':", "case 'sequences':", "case 'sequenceLoaded':", "case 'sequenceStoreError':"]) {
    assert.ok(src.includes(c), `缺序列消息路由 ${c}`);
  }
  for (const fn of [
    'addToSequence: function', 'buildSequencePayload: function', 'applySeqEvent: function',
    'runSequence: function', 'setView: function', 'hasSeqReport: function', 'stepRefProblems: function',
    'seqHasRunningStream: function', 'setSeqTab: function',
    'seqChunkCountText: function', 'seqMaxMsgsValue: function', 'streamIsCapped: function',
    'setSeqMaxMsgs: function',
    'isSeqStepOpen: function', 'toggleSeqStep: function',
  ]) {
    assert.ok(src.includes(fn), `缺序列方法 ${fn}`);
  }
  assert.ok(src.includes("view: 'services'"), 'workbench store 缺 view 默认态');
});

test('runSequence 早退:不可达/运行中在发 runSequence 消息之前拦下', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('runSequence: function');
  const end = src.indexOf('stopSequence: function', start);
  const body = src.slice(start, end);
  assert.ok(start >= 0 && end > start, '缺 runSequence');
  assert.ok(body.indexOf("connState === 'fail'") < body.indexOf('sendMessage'), '不可达早退必须在发消息前');
  assert.ok(body.indexOf('this.seqRunning') < body.indexOf('sendMessage'), '运行中早退必须在发消息前');
  assert.ok(body.includes("this.seqTab = 'report'"), '点运行必须切到报告 tab(0.3.62)');
  assert.ok(body.indexOf("this.seqTab = 'report'") < body.indexOf('sendMessage'), '切 tab 必须在发消息前');
});

test('固定 toast 居中不得依赖 transform(0.3.71):Alpine 过渡会内联写 transform 抵消 translateX', () => {
  const css = fs.readFileSync(path.resolve('media/runner/runner.css'), 'utf8');
  const start = css.indexOf('.refresh-notice {');
  assert.ok(start >= 0, '缺 .refresh-notice 规则');
  const end = css.indexOf('}', start);
  const rule = css.slice(start, end);
  // 进入过渡期间 Alpine 恒向内联写 transform:scale(...)(vendored alpine 实证),
  // 任何以 transform 居中/定位的元素都会被抵消到过渡结束才跳正
  assert.ok(!rule.includes('transform'), '.refresh-notice 不得用 transform 居中(toast 会延迟跳正)');
  assert.ok(rule.includes('margin-inline: auto'), '应改 left/right:0 + auto margin 的 transform-free 居中');
  assert.ok(rule.includes('position: fixed'), 'toast 须保持固定定位');
});

test('runner.css 结构完整:花括号配平且无复制粘贴残留的重复规则(0.3.71)', () => {
  const css = fs.readFileSync(path.resolve('media/runner/runner.css'), 'utf8');
  // 0.3.71 实证:文件尾部曾残留「孤立声明 + 多余 } + 三条重复规则」的编辑损坏,
  // CSS 容错会静默丢弃畸形片段,无任何测试能发现——这里做最小守卫。
  const opens = (css.match(/\{/g) ?? []).length;
  const closes = (css.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, `花括号不配平(${opens} vs ${closes}):规则被截断或残留`);

  // 同选择器 + 同声明体且相距不远 = 复制粘贴残留(层叠细化是正当的:
  // 同选择器但声明体不同,如 .btn:disabled 后一条补 pointer-events)
  const ruleRe = /([.#:&\[\]\w][^{}]*?)\s*\{([^{}]*)\}/g;
  const seen: Array<{ sel: string; body: string; line: number }> = [];
  const dups: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css))) {
    const sel = m[1].trim();
    if (sel.startsWith('@') || sel.startsWith('/*')) continue;
    const body = m[2].replace(/\s+/g, ' ').trim();
    const line = css.slice(0, m.index).split('\n').length;
    const hit = seen.find((s) => s.sel === sel && s.body === body && Math.abs(s.line - line) < 40);
    if (hit) dups.push(`${sel}(第 ${hit.line} 与 ${line} 行)`);
    seen.push({ sel, body, line });
  }
  assert.deepEqual(dups, [], `复制粘贴残留的重复规则: ${dups.join(' | ')}`);
});

// ---- 0.3.70 UX 增强守卫 ----

test('流式中途出错保留已收 chunk(0.3.70):streamIsTreeable 不再因 error 隐藏,错误走独立横幅', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('streamIsTreeable: function');
  const end = src.indexOf('streamErrorText: function', start);
  assert.ok(start >= 0 && end > start, '缺 streamIsTreeable/streamErrorText');
  const body = src.slice(start, end);
  // 树可见性只取决于有无 chunk:不再检查 result 是否 error
  assert.ok(!body.includes("status !== 'error'"), 'streamIsTreeable 不得因结果出错而隐藏已收 chunk');
  assert.ok(src.includes('streamErrorText: function'), '缺错误文本助手(横幅数据源)');

  // getStreamBody 优先复制 chunk:出错时也只拷错误文本会把已收数据丢掉
  const gStart = src.indexOf('getStreamBody: function');
  const gEnd = src.indexOf('copyStreamResult: function', gStart);
  const gBody = src.slice(gStart, gEnd);
  assert.ok(
    gBody.indexOf('stream.chunks') < gBody.indexOf("status === 'error'"),
    'getStreamBody 必须先看 chunk,再退回错误文本',
  );
});

test('序列保存/删除不得在 webview 内 confirm(0.3.72):沙箱 iframe 未设 allow-modals,confirm() 被忽略且抛错', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  // 实证:点击删除报 "Ignored call to 'confirm()'. The document is sandboxed,
  // and the 'allow-modals' keyword is not set." —— 确认一律走宿主原生对话框,
  // webview 只负责发消息。
  assert.ok(!src.includes('window.confirm'), 'webview 内不得再出现 confirm()(沙箱禁用,调用即抛错)');
  assert.ok(!src.includes('seqOverwriteConfirm') && !src.includes('seqDeleteConfirm'), '失效的 webview 确认文案应已移除');

  const saveStart = src.indexOf('saveSequence: function');
  const saveEnd = src.indexOf('loadSequence: function', saveStart);
  const saveBody = src.slice(saveStart, saveEnd);
  assert.ok(saveBody.includes("type: 'saveSequence'"), '保存须直接发消息(确认在宿主侧)');

  const delStart = src.indexOf('deleteSequence: function');
  const delEnd = src.indexOf('showSeqNotice: function', delStart);
  const delBody = src.slice(delStart, delEnd);
  assert.ok(delBody.includes("type: 'deleteSequence'"), '删除须直接发消息(确认在宿主侧)');
});

test('原始 JSON / 树切换(0.3.70):toggleRaw + isRawOpen 齐备', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  assert.ok(src.includes('rawOpen: {}'), '缺 rawOpen 状态字典');
  assert.ok(src.includes('toggleRaw: function'), '缺 toggleRaw');
  assert.ok(src.includes('isRawOpen: function'), '缺 isRawOpen');
});

test('表单重置(0.3.70):resetForm 复位表单值并同步 JSON 页', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  const start = src.indexOf('resetForm: function');
  const end = src.indexOf('filteredServices: function', start);
  assert.ok(start >= 0 && end > start, '缺 resetForm');
  const body = src.slice(start, end);
  assert.ok(body.includes('initFieldValues'), '必须按 schema 重置为默认值');
  assert.ok(body.includes('setJsonText'), '必须同步复位 JSON 页文本(否则切过去直接发出旧值)');
  assert.ok(body.includes('setFormError'), '必须清掉旧校验问题');
});

test('在途调用实时计时(0.3.70):markLoading 记时 + tickElapsed 停表 + elapsedText 展示', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  assert.ok(src.includes('loadingSince: {}'), '缺 loadingSince 状态');
  assert.ok(src.includes('markLoading: function'), '缺 markLoading(置 loading 并记起始时间)');
  assert.ok(src.includes('tickElapsed: function'), '缺 tickElapsed(驱动重渲染 + 无在途即停表)');
  assert.ok(src.includes('elapsedText: function'), '缺 elapsedText');
  // 发送入口必须走 markLoading(而非裸 setLoading),否则不计时
  const submitStart = src.indexOf('submitCall: function');
  const submitEnd = src.indexOf('startStream: function', submitStart);
  assert.ok(src.slice(submitStart, submitEnd).includes('this.markLoading(key)'), 'submitCall 必须走 markLoading');
  const streamStart = src.indexOf('startStream: function');
  const streamEnd = src.indexOf('cancelStream: function', streamStart);
  assert.ok(src.slice(streamStart, streamEnd).includes('this.markLoading(key)'), 'startStream 必须走 markLoading');
});

test('搜索命中高亮 + 全部收起(0.3.70):nameSegments / collapseAllServices 齐备', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  assert.ok(src.includes('nameSegments: function'), '缺 nameSegments(高亮分段)');
  assert.ok(src.includes('collapseAllServices: function'), '缺 collapseAllServices');
  // 同源实跑:子串整段高亮 / 模糊按序高亮 / 未命中原样
  const start = src.indexOf('nameSegments: function');
  const end = src.indexOf('collapseAllServices: function', start);
  const impl = new Function(`return {${src.slice(start, end)}};`)() as {
    nameSegments(name: string, query: string): Array<{ text: string; hit: boolean }>;
  };
  assert.deepEqual(impl.nameSegments('ExecuteOpenLDProg', 'ldp'), [
    { text: 'ExecuteOpen', hit: false },
    { text: 'LDP', hit: true },
    { text: 'rog', hit: false },
  ]);
  assert.deepEqual(impl.nameSegments('ClickEnter', 'ce'), [
    { text: 'C', hit: true },
    { text: 'lick', hit: false },
    { text: 'E', hit: true },
    { text: 'nter', hit: false },
  ]);
  assert.deepEqual(impl.nameSegments('Greeter', 'zzz'), [{ text: 'Greeter', hit: false }]);
  assert.deepEqual(impl.nameSegments('Greeter', ''), [{ text: 'Greeter', hit: false }]);
});

test('config 消息路由(0.3.70):runner.* 改动实时纠正顶栏 server 与空态 protoDir', () => {
  const src = fs.readFileSync(RUNNER_JS, 'utf8');
  assert.ok(src.includes("case 'config':"), '缺 config 消息路由');
  const start = src.indexOf("case 'config':");
  const body = src.slice(start, src.indexOf('break;', start));
  assert.ok(body.includes('cfgStore.server = msg.server'), '必须更新顶栏 server');
  assert.ok(body.includes('cfgStore.protoDir = msg.protoDir'), '必须更新空态 protoDir');
});

test("str() 键必须有处可查:本地 STRING_DEFAULTS 或宿主 boot.strings 至少命中一处(0.3.70)", () => {  const src = fs.readFileSync(RUNNER_JS, 'utf8');

  // runner.js 里全部 str('key') 调用点
  const used = new Set<string>();
  const useRe = /\bstr\('([A-Za-z0-9_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(src))) used.add(m[1]);
  assert.ok(used.size > 10, `str() 调用点扫描失效?仅 ${used.size} 个`);

  // 本地默认串(STRING_DEFAULTS 块)与宿主下发串(webviewHtml.ts 的 strings 对象)
  // 的键提取:值形态不限('...' 或 l10n.t('...')),注释行以 // 开头不匹配
  const defStart = src.indexOf('var STRING_DEFAULTS = {');
  assert.ok(defStart >= 0, '缺 STRING_DEFAULTS');
  const defEnd = src.indexOf('};', defStart);
  const localKeys = new Set<string>();
  const keyRe = /^\s{4}([A-Za-z0-9_]+):/gm;
  while ((m = keyRe.exec(src.slice(defStart, defEnd)))) localKeys.add(m[1]);

  // 宿主经 boot.strings 下发的键(webviewHtml.ts 的 strings 对象;静态 S 不进 webview,不算)
  const htmlSrc = fs.readFileSync(path.resolve('src/runner/webviewHtml.ts'), 'utf8');
  const strStart = htmlSrc.indexOf('const strings = {');
  assert.ok(strStart >= 0, 'webviewHtml.ts 缺 strings 对象');
  const strEnd = htmlSrc.indexOf('};', strStart);
  const hostKeys = new Set<string>();
  keyRe.lastIndex = 0;
  while ((m = keyRe.exec(htmlSrc.slice(strStart, strEnd)))) hostKeys.add(m[1]);

  const missing = [...used].filter((k) => !localKeys.has(k) && !hostKeys.has(k));
  assert.deepEqual(
    missing,
    [],
    `str() 键两处都查不到(webview 会显示原始键名): ${missing.join(', ')}`,
  );
});
