import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProtoError } from '../protoErrorMessage';

/**
 * protoErrorMessage 的文法单测:措辞样本来自项目安装的 protobufjs 实测
 * (parse.js illegal / namespace.js lookup* / type.js add)。
 * 分段恒拼回原文、恒非空——webview 无需兜底。
 */

test("语法错:file、line、token 三段高亮;分段拼回原文", () => {
  const msg = "illegal token '}' (D:\\p\\bad.proto, line 5)";
  const p = parseProtoError(msg);
  assert.equal(p.quotedToken, '}');
  assert.deepEqual(
    p.segments.filter((s) => s.spot).map((s) => [s.text, s.spot]),
    [
      ['}', 'token'],
      ['D:\\p\\bad.proto', 'file'],
      ['line 5', 'line'],
    ],
  );
  assert.equal(p.segments.map((s) => s.text).join(''), msg, '分段恒拼回原文');
});

test('protoLoader 前缀:Windows 盘符冒号不误判,前后两处 file 都高亮', () => {
  const msg = "D:\\p\\sub\\bad.proto: illegal token '}' (D:\\p\\sub\\bad.proto, line 5)";
  const p = parseProtoError(msg);
  assert.equal(p.quotedToken, '}');
  assert.deepEqual(
    p.segments.filter((s) => s.spot).map((s) => [s.text, s.spot]),
    [
      ['D:\\p\\sub\\bad.proto', 'file'],
      ['}', 'token'],
      ['D:\\p\\sub\\bad.proto', 'file'],
      ['line 5', 'line'],
    ],
  );
  assert.equal(p.segments.map((s) => s.text).join(''), msg);
});

test('缺类型两形一次收齐(合并消息),按出现序;两处都标 type', () => {
  const msg = "no such type: a.B\nno such Type or Enum 'c.D' in Type .x.Foo";
  const p = parseProtoError(msg);
  assert.deepEqual(p.missingTypes, ['a.B', 'c.D']);
  assert.deepEqual(
    p.segments.filter((s) => s.spot).map((s) => [s.text, s.spot]),
    [
      ['a.B', 'type'],
      ['c.D', 'type'],
    ],
  );
  assert.equal(p.segments.map((s) => s.text).join(''), msg);
});

test("duplicate name:Namespace 形取全限定 container(去前导点);Type/Enum 取父短名;Root 无", () => {
  const ns = parseProtoError("duplicate name 'Foo' in Namespace .dup.v1");
  assert.deepEqual(ns.duplicateName, { name: 'Foo', kind: 'Namespace', container: 'dup.v1' });
  const ty = parseProtoError("duplicate name 'Foo' in Type A");
  assert.deepEqual(ty.duplicateName, { name: 'Foo', kind: 'Type', container: 'A' });
  const en = parseProtoError("duplicate name 'A' in Enum E");
  assert.deepEqual(en.duplicateName, { name: 'A', kind: 'Enum', container: 'E' });
  const root = parseProtoError("duplicate name 'Foo' in Root");
  assert.deepEqual(root.duplicateName, { name: 'Foo', kind: 'Root', container: undefined });
});

test('普通消息(非 proto 错误文法):单段纯文本,字段全空', () => {
  const msg = 'protoDir not found: D:/protos';
  const p = parseProtoError(msg);
  assert.deepEqual(p.segments, [{ text: msg }]);
  assert.equal(p.quotedToken, undefined);
  assert.deepEqual(p.missingTypes, []);
  assert.equal(p.duplicateName, undefined);
});
