import { Range, SymbolEntry, TypeRef, ServicePoint } from './symbols';

/**
 * 零语义扫描器(ADR-0003):从 proto 源码文本提取定义点(名字 + range)、
 * package 名、import 路径与类型引用位置。不解析类型、不验证合法性;
 * 遇到坏掉的输入尽量提取,提不出就跳过,绝不抛异常。
 *
 * Token 化思路借鉴自已退役的 src/parser/lexer.ts:
 * 点分标识符(a.b.Foo)是单个 token,前导点(.pkg.Type)是独立 punct。
 */

type TokenKind = 'ident' | 'number' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  range: Range;
}

const PUNCT = new Set([
  '{', '}', '(', ')', '<', '>', '[', ']',
  ';', ',', '=', '.', '-',
]);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 0;
  let col = 0;

  function advance(n = 1): void {
    for (let i = 0; i < n; i++) {
      if (source[pos] === '\n') {
        line++;
        col = 0;
      } else {
        col++;
      }
      pos++;
    }
  }

  function here() {
    return { line, character: col };
  }

  function skipWhitespaceAndComments(): void {
    while (pos < source.length) {
      const ch = source[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        advance();
      } else if (ch === '/' && source[pos + 1] === '/') {
        while (pos < source.length && source[pos] !== '\n') advance();
      } else if (ch === '/' && source[pos + 1] === '*') {
        advance(2);
        while (pos < source.length && !(source[pos] === '*' && source[pos + 1] === '/')) advance();
        if (pos < source.length) advance(2);
      } else {
        break;
      }
    }
  }

  function readString(quote: string): void {
    const start = here();
    advance(); // opening quote
    let text = '';
    while (pos < source.length && source[pos] !== quote && source[pos] !== '\n') {
      if (source[pos] === '\\') {
        advance();
        if (pos < source.length) {
          text += source[pos];
          advance();
        }
      } else {
        text += source[pos];
        advance();
      }
    }
    if (pos < source.length && source[pos] === quote) advance(); // closing quote
    tokens.push({ kind: 'string', text, range: { start, end: here() } });
  }

  function readNumber(): void {
    const start = here();
    let text = '';
    if (source[pos] === '-') {
      text += '-';
      advance();
    }
    while (pos < source.length && /[0-9a-fA-FxX.]/.test(source[pos])) {
      text += source[pos];
      advance();
    }
    tokens.push({ kind: 'number', text, range: { start, end: here() } });
  }

  function readIdent(): void {
    const start = here();
    let text = '';
    while (pos < source.length && /[a-zA-Z0-9_.]/.test(source[pos])) {
      text += source[pos];
      advance();
    }
    tokens.push({ kind: 'ident', text, range: { start, end: here() } });
  }

  while (true) {
    skipWhitespaceAndComments();
    if (pos >= source.length) {
      tokens.push({ kind: 'eof', text: '', range: { start: here(), end: here() } });
      break;
    }

    const ch = source[pos];
    if (ch === '"' || ch === "'") {
      readString(ch);
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      readNumber();
    } else if (/[a-zA-Z_]/.test(ch)) {
      readIdent();
    } else if (PUNCT.has(ch)) {
      const start = here();
      advance();
      tokens.push({ kind: 'punct', text: ch, range: { start, end: here() } });
    } else {
      // skip unknown character
      advance();
    }
  }

  return tokens;
}

/** Everything the scanner can extract from one source text */
export interface ScanResult {
  packageName: string | null;
  imports: string[];
  symbols: SymbolEntry[];
  typeRefs: TypeRef[];
  services: ServicePoint[];
}

type ScopeKind = 'message' | 'enum' | 'service' | 'oneof' | 'other';

export function scanProto(source: string): ScanResult {
  const tokens = lex(source);
  const result: ScanResult = { packageName: null, imports: [], symbols: [], typeRefs: [], services: [] };
  const scopes: ScopeKind[] = [];
  const messageNames: string[] = []; // enclosing message names, for qualifiedName
  let currentService: ServicePoint | null = null;
  let i = 0;

  const peek = (offset = 0): Token => tokens[Math.min(i + offset, tokens.length - 1)];
  const at = (kind: TokenKind, text?: string): boolean => {
    const t = peek();
    return t.kind === kind && (text === undefined || t.text === text);
  };
  const atIdent = (text: string): boolean => at('ident', text);

  /** Consume through the next ';' (inclusive); stop at '{', '}' or eof */
  function skipStatement(): void {
    while (!at('eof') && !at('punct', ';') && !at('punct', '{') && !at('punct', '}')) i++;
    if (at('punct', ';')) i++;
  }

  /** Read a type reference: optional leading dot + dotted ident (single token) */
  function readTypeRef(): void {
    const dotted = at('punct', '.');
    const start = dotted ? tokens[i++].range.start : peek().range.start;
    if (!at('ident')) return;
    const t = tokens[i++];
    result.typeRefs.push({
      name: (dotted ? '.' : '') + t.text,
      range: { start, end: t.range.end },
    });
  }

  /** Read `message|enum|service Name {`; record the definition point, enter its scope */
  function readDefinition(kind: 'message' | 'enum' | 'service'): void {
    i++; // keyword
    if (!at('ident')) return;
    const nameTok = tokens[i++];
    const qualified = messageNames.length
      ? [...messageNames, nameTok.text].join('.')
      : nameTok.text;
    result.symbols.push({ name: nameTok.text, qualifiedName: qualified, range: nameTok.range, kind });
    while (!at('eof') && !at('punct', '{') && !at('punct', ';') && !at('punct', '}')) i++;
    if (at('punct', '{')) {
      i++;
      scopes.push(kind);
      if (kind === 'message') messageNames.push(nameTok.text);
      if (kind === 'service') {
        const point: ServicePoint = { name: nameTok.text, range: nameTok.range, methods: [] };
        result.services.push(point);
        currentService = point;
      }
    }
  }

  function scanFileScope(): void {
    if (atIdent('package')) {
      i++;
      if (at('ident')) result.packageName = tokens[i++].text;
      skipStatement();
      return;
    }
    if (atIdent('import')) {
      i++;
      if (atIdent('weak') || atIdent('public')) i++;
      if (at('string')) result.imports.push(tokens[i++].text);
      skipStatement();
      return;
    }
    // syntax / option / extend / unknown: skip the statement; a trailing block is opaque
    skipStatement();
    if (at('punct', '{')) {
      scopes.push('other');
      i++;
    }
  }

  /** Read one rpc type: `(stream? Type)`; tolerant of a missing '(' . 返回是否带 stream */
  function readRpcType(): boolean {
    let sawStream = false;
    while (!at('eof') && !at('punct', '(') && !at('punct', ';') && !at('punct', '{') && !at('punct', '}')) {
      if (atIdent('returns')) return false; // broken rpc without parens
      i++;
    }
    if (!at('punct', '(')) return false;
    i++;
    if (atIdent('stream')) {
      sawStream = true;
      i++;
    }
    readTypeRef();
    while (!at('eof') && !at('punct', ')')) i++;
    if (at('punct', ')')) i++;
    return sawStream;
  }

  function scanServiceScope(): void {
    if (!atIdent('rpc')) {
      skipStatement();
      return;
    }
    i++;
    const nameTok = at('ident') ? tokens[i++] : null;
    const requestStream = readRpcType();
    let responseStream = false;
    if (atIdent('returns')) {
      i++;
      responseStream = readRpcType();
    }
    if (nameTok && currentService) {
      currentService.methods.push({
        name: nameTok.text,
        range: nameTok.range,
        requestStream,
        responseStream,
      });
    }
    skipStatement();
    if (at('punct', '{')) {
      scopes.push('other'); // rpc body with options
      i++;
    }
  }

  function scanMessageScope(isMessage: boolean): void {
    if (atIdent('option') || atIdent('reserved') || atIdent('extensions')) {
      skipStatement();
      return;
    }
    if (isMessage && atIdent('oneof')) {
      i++;
      while (!at('eof') && !at('punct', '{') && !at('punct', ';') && !at('punct', '}')) i++;
      if (at('punct', '{')) {
        scopes.push('oneof');
        i++;
      } else if (at('punct', ';')) {
        i++;
      }
      return;
    }
    if (isMessage && atIdent('map') && peek(1).kind === 'punct' && peek(1).text === '<') {
      i += 2; // map <
      if (at('ident')) i++; // key type is always scalar — not a ref (old behavior)
      if (at('punct', ',')) i++;
      readTypeRef(); // value type
      skipStatement();
      return;
    }
    if (atIdent('repeated') || atIdent('optional') || atIdent('required')) {
      i++;
      readTypeRef();
      skipStatement();
      return;
    }
    if (at('ident') || at('punct', '.')) {
      // normal field: type is the first token
      readTypeRef();
      skipStatement();
      return;
    }
    i++; // numbers / strings / stray punct: skip one token, never stall
  }

  while (!at('eof')) {
    if (at('punct', '}')) {
      const popped = scopes.pop();
      if (popped === 'message') messageNames.pop();
      if (popped === 'service') currentService = null;
      i++;
      continue;
    }
    if (at('punct', '{')) {
      scopes.push('other');
      i++;
      continue;
    }
    if (at('punct', ';')) {
      i++;
      continue;
    }

    const scope = scopes.length ? scopes[scopes.length - 1] : 'file';
    if (scope === 'enum' || scope === 'other') {
      i++; // enum values and opaque blocks carry no definitions or type refs
      continue;
    }

    if (atIdent('message')) {
      readDefinition('message');
      continue;
    }
    if (atIdent('enum')) {
      readDefinition('enum');
      continue;
    }
    if (atIdent('service')) {
      readDefinition('service');
      continue;
    }

    if (scope === 'file') scanFileScope();
    else if (scope === 'service') scanServiceScope();
    else scanMessageScope(scope === 'message');
  }

  return result;
}

/** All type reference positions in a file (for semantic tokens / navigation) */
export function scanTypeRefs(source: string): TypeRef[] {
  return scanProto(source).typeRefs;
}
