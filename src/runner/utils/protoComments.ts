import { readProtoFile } from '../../runtime/protoEncoding';

export interface ProtoCommentIndex {
  fieldComments: Map<string, string>;
  enumValueComments: Map<string, string>;
}

interface BlockContext {
  kind: 'message' | 'enum';
  name: string;
  openDepth: number;
}

function storeFieldComment(
  map: Map<string, string>,
  messageName: string,
  fieldName: string,
  comment: string
): void {
  const trimmed = comment.trim();
  if (!trimmed) {
    return;
  }
  map.set(`${messageName}.${fieldName}`, trimmed);
  const camel = fieldName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camel !== fieldName) {
    map.set(`${messageName}.${camel}`, trimmed);
  }
}

export function parseProtoFileComments(content: string): ProtoCommentIndex {
  const fieldComments = new Map<string, string>();
  const enumValueComments = new Map<string, string>();
  const blocks: BlockContext[] = [];
  let pending: { kind: 'message' | 'enum'; name: string } | null = null;
  let pendingDepth = 0;
  let pkg = '';
  let depth = 0;
  // 前导注释链(0.3.44):声明行上方的连续 // 行与 /* */ 块;行尾注释优先,空行/代码行断链
  let pendingComment: string[] = [];
  let inBlockComment = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (inBlockComment) {
      const endIdx = trimmed.indexOf('*/');
      const seg = endIdx === -1 ? trimmed : trimmed.slice(0, endIdx);
      const cleaned = seg.replace(/^\*+\s?/, '').trim();
      if (cleaned) pendingComment.push(cleaned);
      if (endIdx !== -1) inBlockComment = false;
      continue;
    }
    if (!trimmed) {
      pendingComment = [];
      continue;
    }
    if (trimmed.startsWith('//')) {
      const text = trimmed.slice(2).trim();
      if (text) pendingComment.push(text);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const endIdx = trimmed.indexOf('*/', 2);
      const inner = endIdx === -1 ? trimmed.slice(2) : trimmed.slice(2, endIdx);
      const cleaned = inner.replace(/^\*+\s?/, '').trim();
      if (cleaned) pendingComment.push(cleaned);
      if (endIdx === -1) inBlockComment = true;
      continue;
    }

    const packageMatch = trimmed.match(/^package\s+([\w.]+)\s*;/);
    if (packageMatch) {
      pkg = packageMatch[1];
    }

    // Allman 括号:message/enum 声明行不带 {,块在下一行 { 才开始。
    // 声明时记下待入块,遇到以 { 开头的行才入栈(openDepth 取声明行的深度)。
    if (pending && trimmed.includes('{')) {
      if (trimmed.startsWith('{')) {
        blocks.push({ ...pending, openDepth: pendingDepth });
      }
      pending = null;
    }

    const messageOpen = trimmed.match(/^message\s+(\w+)\s*\{/);
    if (messageOpen) {
      blocks.push({ kind: 'message', name: messageOpen[1], openDepth: depth });
    } else {
      const messageDecl = trimmed.match(/^message\s+(\w+)\s*$/);
      if (messageDecl) {
        pending = { kind: 'message', name: messageDecl[1] };
        pendingDepth = depth;
      }
    }

    const enumOpen = trimmed.match(/^enum\s+(\w+)\s*\{/);
    if (enumOpen) {
      blocks.push({ kind: 'enum', name: enumOpen[1], openDepth: depth });
    } else {
      const enumDecl = trimmed.match(/^enum\s+(\w+)\s*$/);
      if (enumDecl) {
        pending = { kind: 'enum', name: enumDecl[1] };
        pendingDepth = depth;
      }
    }

    const ctx = blocks[blocks.length - 1];
    if (ctx) {
      // 键 = 全限定名(包 + 嵌套路径):跨包/跨文件同名 message/enum 的注释互不覆盖
      const fqn = (pkg ? `${pkg}.` : '') + blocks.map((b) => b.name).join('.');
      if (ctx.kind === 'message') {
        const fieldMatch = trimmed.match(
          /^(?:(?:optional|repeated)\s+)?(?:[\w.]+\s+)?(\w+)\s*=\s*-?\d+\s*;\s*(?:\/\/\s*(.+))?$/
        );
        if (fieldMatch) {
          // 行尾注释优先;缺失时取上方前导注释链(多行以空格连接,webview 单行展示)
          const text = fieldMatch[2] ? fieldMatch[2].trim() : pendingComment.join(' ').trim();
          storeFieldComment(fieldComments, fqn, fieldMatch[1], text);
        }
      } else if (ctx.kind === 'enum') {
        const enumMatch = trimmed.match(/^(\w+)\s*=\s*-?\d+\s*;\s*(?:\/\/\s*(.+))?$/);
        if (enumMatch) {
          const text = enumMatch[2] ? enumMatch[2].trim() : pendingComment.join(' ').trim();
          if (text) {
            enumValueComments.set(`${fqn}.${enumMatch[1]}`, text);
          }
        }
      }
    }

    // 任何代码行都消费/打断前导注释链(声明行无论是否命中也已用掉)
    pendingComment = [];

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    depth += opens - closes;

    while (blocks.length > 0 && depth <= blocks[blocks.length - 1].openDepth) {
      blocks.pop();
    }
  }

  return { fieldComments, enumValueComments };
}

export function buildProtoCommentIndex(protoFiles: string[]): ProtoCommentIndex {
  const fieldComments = new Map<string, string>();
  const enumValueComments = new Map<string, string>();

  for (const file of protoFiles) {
    let content: string;
    try {
      content = readProtoFile(file);
    } catch {
      continue;
    }

    const parsed = parseProtoFileComments(content);
    for (const [key, value] of parsed.fieldComments) {
      fieldComments.set(key, value);
    }
    for (const [key, value] of parsed.enumValueComments) {
      enumValueComments.set(key, value);
    }
  }

  return { fieldComments, enumValueComments };
}

export function lookupFieldComment(
  index: ProtoCommentIndex,
  messageName: string | undefined,
  fieldName: string
): string | undefined {
  if (!messageName) {
    return undefined;
  }
  return index.fieldComments.get(`${messageName}.${fieldName}`);
}

export function lookupEnumValueComment(
  index: ProtoCommentIndex,
  enumName: string | undefined,
  valueName: string
): string | undefined {
  if (!enumName) {
    return undefined;
  }
  return index.enumValueComments.get(`${enumName}.${valueName}`);
}
