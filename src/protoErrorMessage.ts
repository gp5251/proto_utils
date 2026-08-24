/**
 * protobufjs/proto-loader 错误消息文法的唯一住处(0.3.40)。
 * 纯函数:不 import vscode/fs——编辑器诊断(loadDiagnostics)与工作台错误卡片
 * (webviewPanel 的 segments)两个平面共用,esbuild 两个 bundle 各自打包。
 *
 * 措辞已对项目安装的 protobufjs 实测:
 *   语法错  parse.js illegal()      → "illegal token '}' (file.proto, line 5)"
 *   缺类型  namespace.js lookup*    → "no such type: a.B"(Method)
 *                                   / "no such Type or Enum 'a.B' in Type .pkg.Foo"(Field)
 *   重名    type/enum/service.js add → "duplicate name 'X' in Namespace .pkg"
 *                                   / "in Type A"(父短名:add 抛错时父对象尚未挂包树)/ "in Root"
 */

/** 出错点类别;webview 只按有无渲染波浪线,类别留给未来区分样式。 */
export type SpotKind = 'type' | 'file' | 'line' | 'token';

/** 错误消息的一段;spot 非空 = 该段是"出错点",渲染红色波浪线。 */
export interface ErrorSegment {
  text: string;
  spot?: SpotKind;
}

export interface ParsedProtoError {
  /** 原始消息(诊断 body / toast 文本原样用)。 */
  message: string;
  /** 分段渲染投影;无命中时 = [{ text: message }](恒非空,webview 无需兜底)。 */
  segments: ErrorSegment[];
  /** 首个引号包裹的违规 token:"illegal token '}'" 等(located 语法错收窄用)。 */
  quotedToken?: string;
  /** 全部缺失类型名,按消息中出现序(合并消息一次多条)。 */
  missingTypes: string[];
  /**
   * 重名错误。container:Namespace 形为全限定名(去前导点);Type/Enum/Service 形为父短名;
   * Root 无 container。
   */
  duplicateName?: {
    name: string;
    kind: 'Namespace' | 'Type' | 'Enum' | 'Service' | 'Root';
    container?: string;
  };
}

/** 一段待高亮的区间。 */
interface Claim {
  start: number;
  end: number;
  spot: SpotKind;
}

// protoLoader 逐文件加载的错误包装:`${file}: ${msg}`。非贪婪停在首个 '.proto:' 前,
// Windows 'D:\' 的冒号不会误判(匹配必须终于 .proto)。
const LOADER_PREFIX_RE = /^([^\n]*?\.proto):\s+/;
// protobufjs parse 错后缀,与 protoFrontend.toProtoLoadError 同一形。
const LOCATED_SUFFIX_RE = /\((.+\.proto), (line \d+)\)\s*$/;
// 缺类型两形:冒号形(Method/旧版)与引号形(Field 的 lookupTypeOrEnum/lookupEnum/lookupService)。
const MISSING_QUOTED_RE = /\bno such (?:Type or Enum|Type|Enum|Service) '([^']+)'/g;
const MISSING_COLON_RE = /\bno such (?:type|name|enum):\s*([\w.]+)/g;
// 重名:名 + 容器种类 + 容器名(Root 无容器名)。实测:"in Namespace .dup.v1" / "in Type A" / "in Root"。
const DUPLICATE_RE = /\bduplicate name '([^']+)' in (Namespace|Type|Enum|Service|Root)(?:\s+(\.?[\w.]+))?/;
const QUOTED_RE = /'([^']+)'/;

/**
 * 捕获组在整段匹配中的起点。用 lastIndexOf 而非 indexOf:种类词可能与捕获内容同前缀
 * (如 "no such Type or Enum 'Type.Foo'" 的 'Type'),取最后一次出现才落在捕获上。
 */
function groupSpan(match: RegExpExecArray, group: string): Claim['start'] {
  return match.index + match[0].lastIndexOf(group);
}

export function parseProtoError(message: string): ParsedProtoError {
  const claims: Claim[] = [];

  const prefix = LOADER_PREFIX_RE.exec(message);
  if (prefix) {
    claims.push({ start: 0, end: prefix[1].length, spot: 'file' });
  }

  const suffix = LOCATED_SUFFIX_RE.exec(message);
  if (suffix) {
    const fileStart = groupSpan(suffix, suffix[1]);
    claims.push({ start: fileStart, end: fileStart + suffix[1].length, spot: 'file' });
    const lineStart = groupSpan(suffix, suffix[2]);
    claims.push({ start: lineStart, end: lineStart + suffix[2].length, spot: 'line' });
  }

  // 缺类型:两形分开收,按出现位置归并排序(合并消息一次多条)。
  const missing: Array<{ index: number; name: string }> = [];
  for (const re of [MISSING_QUOTED_RE, MISSING_COLON_RE]) {
    re.lastIndex = 0; // /g 共享对象:上次 exec 的 lastIndex 会串到下一次
    let m: RegExpExecArray | null;
    while ((m = re.exec(message))) {
      missing.push({ index: m.index, name: m[1] });
      const start = groupSpan(m, m[1]);
      claims.push({ start, end: start + m[1].length, spot: 'type' });
    }
  }
  const missingTypes = missing.sort((a, b) => a.index - b.index).map((x) => x.name);

  let duplicateName: ParsedProtoError['duplicateName'];
  const dup = DUPLICATE_RE.exec(message);
  if (dup) {
    const kind = dup[2] as NonNullable<ParsedProtoError['duplicateName']>['kind'];
    // Namespace 容器是全限定名,归一去前导点;Type/Enum/Service 本就是短名;Root 无容器名
    const container = dup[3] ? dup[3].replace(/^\./, '') : undefined;
    duplicateName = { name: dup[1], kind, container };
    const start = groupSpan(dup, dup[1]);
    claims.push({ start, end: start + dup[1].length, spot: 'token' });
  }

  // 违规 token:首个引号组("illegal token '}'" 的 token 恒为首组);与已认领区间重叠则由 buildSegments 丢弃。
  const quoted = QUOTED_RE.exec(message);
  const quotedToken = quoted?.[1];
  if (quoted && quotedToken) {
    const start = groupSpan(quoted, quotedToken);
    claims.push({ start, end: start + quotedToken.length, spot: 'token' });
  }

  return { message, segments: buildSegments(message, claims), quotedToken, missingTypes, duplicateName };
}

/** 区间认领:按起点排序,重叠先到先得(各文法命中天然不嵌套);未认领区段原样输出。 */
function buildSegments(message: string, claims: Claim[]): ErrorSegment[] {
  const accepted: Claim[] = [];
  for (const c of [...claims].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (accepted.some((x) => c.start < x.end && x.start < c.end)) continue;
    accepted.push(c);
  }
  const segments: ErrorSegment[] = [];
  let cursor = 0;
  for (const c of accepted) {
    if (c.start > cursor) segments.push({ text: message.slice(cursor, c.start) });
    segments.push({ text: message.slice(c.start, c.end), spot: c.spot });
    cursor = c.end;
  }
  if (cursor < message.length) segments.push({ text: message.slice(cursor) });
  if (segments.length === 0) segments.push({ text: message });
  return segments;
}
