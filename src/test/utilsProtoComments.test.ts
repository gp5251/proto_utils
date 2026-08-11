import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProtoFileComments } from '../runner/utils/protoComments';

test('parseProtoFileComments extracts message field and enum value comments', () => {
  const content = `
syntax = "proto3";
package test.v1;

enum ModifyVarType {
  MODIFY_VAR_TYPE_UNSPECIFIED = 0;
  MODIFY_VAR_TYPE_NAME = 1; //名称
  MODIFY_VAR_TYPE_DATATYPE = 2; //数据类型
}

message CreateFBMemVarRequest {
  string fb_name = 1;
  string name = 2;
  optional uint32 index = 3; //插入行索引

  message Inner {
    string note = 1; //嵌套注释
  }
}
`;

  const { fieldComments, enumValueComments } = parseProtoFileComments(content);

  // 键为全限定名:跨包同名 message/enum 的注释互不覆盖
  assert.equal(fieldComments.get('test.v1.CreateFBMemVarRequest.index'), '插入行索引');
  assert.equal(fieldComments.get('test.v1.CreateFBMemVarRequest.Inner.note'), '嵌套注释');
  assert.equal(enumValueComments.get('test.v1.ModifyVarType.MODIFY_VAR_TYPE_NAME'), '名称');
  assert.equal(enumValueComments.get('test.v1.ModifyVarType.MODIFY_VAR_TYPE_DATATYPE'), '数据类型');
});

test('parseProtoFileComments handles Allman braces ({ on the next line)', () => {
  const content = `
syntax = "proto3";
package test.v1;

message LDElemt_Info
{
  uint32 iType = 1;//元件类型
  string sName = 4; //名称
}

enum Mode
{
  MODE_A = 0;//模式A
}
`;

  const { fieldComments, enumValueComments } = parseProtoFileComments(content);

  assert.equal(fieldComments.get('test.v1.LDElemt_Info.iType'), '元件类型');
  assert.equal(fieldComments.get('test.v1.LDElemt_Info.sName'), '名称');
  assert.equal(enumValueComments.get('test.v1.Mode.MODE_A'), '模式A');
});
