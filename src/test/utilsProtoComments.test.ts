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

test('行尾注释缺失时取上方连续 // 前导注释;空行断链;行尾优先', () => {
  const content = `
syntax = "proto3";
package lead.v1;

message Req {
  // 用户唯一标识
  // 多行第二段
  string user_id = 1;

  string skipped = 2;
  string name = 3; // 行尾优先
}
`;

  const { fieldComments } = parseProtoFileComments(content);

  assert.equal(fieldComments.get('lead.v1.Req.user_id'), '用户唯一标识 多行第二段');
  assert.equal(fieldComments.has('lead.v1.Req.skipped'), false, '空行应打断前导注释链');
  assert.equal(fieldComments.get('lead.v1.Req.name'), '行尾优先');
});

test('上方 /* */ 块注释作为前导注释提取(去装饰星号)', () => {
  const content = `
syntax = "proto3";
package blk.v1;

enum State {
  /*
   * 初始态
   * 说明第二行
   */
  STATE_INIT = 0;
}

message Block {
  /* 单行块注释 */
  uint32 status = 1;
}
`;

  const { fieldComments, enumValueComments } = parseProtoFileComments(content);

  assert.equal(fieldComments.get('blk.v1.Block.status'), '单行块注释');
  assert.equal(enumValueComments.get('blk.v1.State.STATE_INIT'), '初始态 说明第二行');
});
