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
}
`;

  const { fieldComments, enumValueComments } = parseProtoFileComments(content);

  assert.equal(fieldComments.get('CreateFBMemVarRequest.index'), '插入行索引');
  assert.equal(enumValueComments.get('ModifyVarType.MODIFY_VAR_TYPE_NAME'), '名称');
  assert.equal(enumValueComments.get('ModifyVarType.MODIFY_VAR_TYPE_DATATYPE'), '数据类型');
});
