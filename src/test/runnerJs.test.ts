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
  assert.ok(sBody.includes('this.setLoading(key, true)'), 'startStream 必须置 loading(按钮发送中态)');

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
});
