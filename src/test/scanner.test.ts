import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProto } from '../index/scanner';

test('scans service methods with stream flags and name ranges', () => {
  const source = [
    'syntax = "proto3";',
    'package c;',
    'service Greeter {',
    '  rpc SayHello (Bar) returns (Bar);',
    '  rpc Subscribe (Bar) returns (stream Bar);',
    '  rpc Upload (stream Bar) returns (Bar);',
    '  rpc Chat (stream Bar) returns (stream Bar);',
    '}',
  ].join('\n');

  const { services } = scanProto(source);
  assert.equal(services.length, 1);
  const greeter = services[0];
  assert.equal(greeter.name, 'Greeter');
  assert.deepEqual(
    greeter.methods.map((m) => [m.name, m.requestStream, m.responseStream]),
    [
      ['SayHello', false, false],
      ['Subscribe', false, true],
      ['Upload', true, false],
      ['Chat', true, true],
    ],
  );

  const subscribe = greeter.methods[1];
  assert.equal(source.split('\n')[4].indexOf('Subscribe'), subscribe.range.start.character);
  assert.equal(subscribe.range.start.line, 4);
});

test('service methods keep file-local names; package qualification is a consumer concern', () => {
  const { services } = scanProto('service S { rpc M (A) returns (B); }');
  assert.equal(services[0].name, 'S');
  assert.equal(services[0].methods[0].name, 'M');
});

test('broken service bodies yield what they can and never throw', () => {
  const { services } = scanProto('service Broken { rpc NoReturn (A) ');
  assert.equal(services.length, 1);
  assert.equal(services[0].methods[0].name, 'NoReturn');
});

test('rpc option bodies do not swallow following methods', () => {
  const source = 'service S { rpc M (A) returns (B) { option deadline = 1; } rpc N (A) returns (B); }';
  const { services } = scanProto(source);
  assert.deepEqual(services[0].methods.map((m) => m.name), ['M', 'N']);
});

test('rpc 方法记录源码书写的请求/响应类型(0.3.70:hover 数据源)', () => {
  const source = [
    'syntax = "proto3";',
    'package c;',
    'service Greeter {',
    '  rpc SayHello (Bar) returns (Baz);',
    '  rpc Subscribe (c.v1.Req) returns (stream c.v1.Res);',
    '  rpc Broken (A) ',
    '}',
  ].join('\n');

  const { services } = scanProto(source);
  const [sayHello, subscribe, broken] = services[0].methods;
  assert.equal(sayHello.requestType, 'Bar');
  assert.equal(sayHello.responseType, 'Baz');
  // 限定名按源码原样(点分标识符是单 token)
  assert.equal(subscribe.requestType, 'c.v1.Req');
  assert.equal(subscribe.responseType, 'c.v1.Res');
  // 残句:请求类型读到了,returns 缺失则 responseType 缺省(不猜)
  assert.equal(broken.requestType, 'A');
  assert.equal(broken.responseType, undefined);
});
