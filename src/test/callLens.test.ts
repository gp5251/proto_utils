import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProto } from '../index/scanner';
import { callableMethods, methodAtLine } from '../providers/callLens';

const SOURCE = [
  'syntax = "proto3";',
  'package a.b;',
  'service Greeter {',
  '  rpc SayHello (Bar) returns (Bar);',
  '  rpc Subscribe (Bar) returns (stream Bar);',
  '  rpc Upload (stream Bar) returns (Bar);',
  '}',
  'service Other {',
  '  rpc Ping (P) returns (P);',
  '}',
].join('\n');

test('callable methods: unary + server-streaming, client-streaming excluded', () => {
  const scanned = scanProto(SOURCE);
  const targets = callableMethods({ packageName: scanned.packageName, services: scanned.services });
  assert.deepEqual(
    targets.map((t) => [t.serviceFullName, t.method]),
    [
      ['a.b.Greeter', 'SayHello'],
      ['a.b.Greeter', 'Subscribe'],
      ['a.b.Other', 'Ping'],
    ],
  );
});

test('service without package falls back to bare name', () => {
  const scanned = scanProto('service S { rpc M (A) returns (B); }');
  const targets = callableMethods({ packageName: scanned.packageName, services: scanned.services });
  assert.equal(targets[0].serviceFullName, 'S');
});

test('each target carries the method definition range', () => {
  const scanned = scanProto(SOURCE);
  const targets = callableMethods({ packageName: scanned.packageName, services: scanned.services });
  const subscribe = targets.find((t) => t.method === 'Subscribe');
  assert.equal(subscribe?.range.start.line, 4);
});

test('methodAtLine: 光标行命中 rpc 方法名所在行时返回调用目标', () => {
  const scanned = scanProto(SOURCE);
  const hit = methodAtLine({ packageName: scanned.packageName, services: scanned.services }, 3);
  assert.deepEqual(hit && { serviceFullName: hit.serviceFullName, method: hit.method }, {
    serviceFullName: 'a.b.Greeter',
    method: 'SayHello',
  });
});

test('methodAtLine: 未命中(service 外/空白行/方法名外的行)返回 null', () => {
  const scanned = scanProto(SOURCE);
  assert.equal(methodAtLine({ packageName: scanned.packageName, services: scanned.services }, 0), null);
  assert.equal(methodAtLine({ packageName: scanned.packageName, services: scanned.services }, 2), null);
  assert.equal(methodAtLine({ packageName: scanned.packageName, services: scanned.services }, 6), null);
});

test('methodAtLine: client-streaming 方法不可调用,不返回', () => {
  const scanned = scanProto(SOURCE);
  assert.equal(methodAtLine({ packageName: scanned.packageName, services: scanned.services }, 5), null);
});
