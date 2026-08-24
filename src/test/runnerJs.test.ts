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
