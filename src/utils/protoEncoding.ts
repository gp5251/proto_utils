import fs from 'node:fs';

export type Encoding = 'utf-8' | 'gbk';

export interface ProtoEncodingCheck {
  filePath: string;
  encoding: Encoding;
  isUtf8: boolean;
}

export function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export function detectEncoding(buffer: Buffer): Encoding {
  if (isValidUtf8(buffer)) return 'utf-8';
  return 'gbk';
}

export function readProtoFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return new TextDecoder(detectEncoding(buffer)).decode(buffer);
}

export function checkProtoFileEncoding(filePath: string): ProtoEncodingCheck {
  const buffer = fs.readFileSync(filePath);
  const encoding = detectEncoding(buffer);
  return {
    filePath,
    encoding,
    isUtf8: encoding === 'utf-8',
  };
}
