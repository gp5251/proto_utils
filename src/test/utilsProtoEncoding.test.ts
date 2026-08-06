import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isValidUtf8,
  detectEncoding,
  decodeProto,
  readProtoFile,
  checkProtoFileEncoding,
} from '../runtime/protoEncoding';

const SAMPLE_GBK_BYTES = Buffer.from([
  0x73, 0x79, 0x6e, 0x74, 0x61, 0x78, 0x20, 0x3d, 0x20, 0x22, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x33,
  0x22, 0x3b, 0x0d, 0x0a, 0x0d, 0x0a, 0x2f, 0x2f, 0x20, 0xd6, 0xd0, 0xce, 0xc4,
]);

function makeTempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-encoding-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('isValidUtf8 returns true for ASCII buffer', () => {
  assert.equal(isValidUtf8(Buffer.from('hello world', 'utf-8')), true);
});

test('isValidUtf8 returns true for UTF-8 multi-byte Chinese text', () => {
  assert.equal(isValidUtf8(Buffer.from('hello 中文', 'utf-8')), true);
});

test('isValidUtf8 returns false for GBK-encoded bytes', () => {
  assert.equal(isValidUtf8(SAMPLE_GBK_BYTES), false);
});

test('isValidUtf8 returns true for empty buffer', () => {
  assert.equal(isValidUtf8(Buffer.alloc(0)), true);
});

test('detectEncoding returns utf-8 for valid UTF-8 bytes', () => {
  assert.equal(detectEncoding(Buffer.from('hello 中文', 'utf-8')), 'utf-8');
});

test('detectEncoding returns gbk for GBK-encoded bytes', () => {
  assert.equal(detectEncoding(SAMPLE_GBK_BYTES), 'gbk');
});

test('detectEncoding returns utf-8 for ASCII', () => {
  assert.equal(detectEncoding(Buffer.from('plain ascii', 'utf-8')), 'utf-8');
});

test('decodeProto decodes bytes with detected encoding', () => {
  assert.equal(decodeProto(SAMPLE_GBK_BYTES), 'syntax = "proto3";\r\n\r\n// 中文');
  assert.equal(decodeProto(Buffer.from('syntax = "proto3";', 'utf-8')), 'syntax = "proto3";');
});

test('readProtoFile returns the same text for a UTF-8 file', (t) => {
  const tempDir = makeTempDir(t);
  const file = path.join(tempDir, 'utf8.proto');
  fs.writeFileSync(file, 'syntax = "proto3"; // 中文', 'utf-8');
  assert.equal(readProtoFile(file), 'syntax = "proto3"; // 中文');
});

test('readProtoFile decodes GBK-encoded file correctly', (t) => {
  const tempDir = makeTempDir(t);
  const file = path.join(tempDir, 'gbk.proto');
  fs.writeFileSync(file, SAMPLE_GBK_BYTES);
  assert.equal(readProtoFile(file), 'syntax = "proto3";\r\n\r\n// 中文');
});

test('readProtoFile preserves CRLF line endings', (t) => {
  const tempDir = makeTempDir(t);
  const file = path.join(tempDir, 'crlf.proto');
  fs.writeFileSync(file, 'line1\r\nline2\r\n', 'utf-8');
  const result = readProtoFile(file);
  assert.equal(result, 'line1\r\nline2\r\n');
  assert.ok(result.includes('\r\n'));
});

test('checkProtoFileEncoding reports utf-8 for a UTF-8 file', (t) => {
  const tempDir = makeTempDir(t);
  const file = path.join(tempDir, 'utf8.proto');
  fs.writeFileSync(file, 'syntax = "proto3"; // 中文', 'utf-8');
  const result = checkProtoFileEncoding(file);
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.isUtf8, true);
  assert.equal(result.filePath, file);
});

test('checkProtoFileEncoding reports gbk for a GBK-encoded file', (t) => {
  const tempDir = makeTempDir(t);
  const file = path.join(tempDir, 'gbk.proto');
  fs.writeFileSync(file, SAMPLE_GBK_BYTES);
  const result = checkProtoFileEncoding(file);
  assert.equal(result.encoding, 'gbk');
  assert.equal(result.isUtf8, false);
  assert.equal(result.filePath, file);
});
