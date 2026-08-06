import fs from 'fs';

export type Encoding = 'utf-8' | 'gbk';

export interface ProtoEncodingCheck {
  filePath: string;
  encoding: Encoding;
  isUtf8: boolean;
}

export function isValidUtf8(buffer: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export function detectEncoding(buffer: Uint8Array): Encoding {
  if (isValidUtf8(buffer)) return 'utf-8';
  return 'gbk';
}

/** 编码感知的 proto 文本解码:严格 UTF-8 校验失败即按 GBK 处理。 */
export function decodeProto(bytes: Uint8Array): string {
  return new TextDecoder(detectEncoding(bytes)).decode(bytes);
}

export function readProtoFile(filePath: string): string {
  return decodeProto(fs.readFileSync(filePath));
}

export function checkProtoFileEncoding(filePath: string): ProtoEncodingCheck {
  const encoding = detectEncoding(fs.readFileSync(filePath));
  return {
    filePath,
    encoding,
    isUtf8: encoding === 'utf-8',
  };
}
