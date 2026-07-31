import { Position, Range } from './ast';

export type TokenKind =
  | 'ident'
  | 'number'
  | 'string'
  | 'punct'
  | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  range: Range;
}

const PUNCT = new Set([
  '{', '}', '(', ')', '<', '>', '[', ']',
  ';', ',', '=', '.', '-',
]);

export function lex(source: string): Token[] {
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

  function here(): Position {
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

  function readString(quote: string): Token {
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
    return { kind: 'string', text, range: { start, end: here() } };
  }

  function readNumber(): Token {
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
    return { kind: 'number', text, range: { start, end: here() } };
  }

  function readIdent(): Token {
    const start = here();
    let text = '';
    while (pos < source.length && /[a-zA-Z0-9_.]/.test(source[pos])) {
      text += source[pos];
      advance();
    }
    return { kind: 'ident', text, range: { start, end: here() } };
  }

  while (true) {
    skipWhitespaceAndComments();
    if (pos >= source.length) {
      tokens.push({ kind: 'eof', text: '', range: { start: here(), end: here() } });
      break;
    }

    const ch = source[pos];

    if (ch === '"' || ch === "'") {
      tokens.push(readString(ch));
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      tokens.push(readNumber());
    } else if (/[a-zA-Z_]/.test(ch)) {
      tokens.push(readIdent());
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
