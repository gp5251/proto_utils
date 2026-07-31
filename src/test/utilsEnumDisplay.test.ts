import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumOptionLabel } from '../utils/enumDisplay';

test('enumOptionLabel shows enum number on the right', () => {
  const options = [
    { name: 'MODIFY_VAR_TYPE_UNSPECIFIED', number: 0 },
    { name: 'MODIFY_VAR_TYPE_NAME', number: 1, comment: '名称' },
  ];
  assert.match(enumOptionLabel(options[0], options), /MODIFY_VAR_TYPE_UNSPECIFIED\s+0$/);
  assert.ok(enumOptionLabel(options[1], options).includes('—'));
  assert.match(enumOptionLabel(options[1], options), /MODIFY_VAR_TYPE_NAME.*1.*名称/);
});
