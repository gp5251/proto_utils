import { lex, Token } from './lexer';
import * as ast from './ast';

export function parse(source: string): ast.ProtoFile {
  const tokens = lex(source);
  const p = new Parser(tokens);
  return p.parseFile();
}

class Parser {
  private tokens: Token[];
  private i = 0;
  private diagnostics: ast.Diagnostic[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // ─── Helpers ─────────────────────────────────────────────

  private peek(): Token {
    return this.tokens[this.i] ?? this.tokens[this.tokens.length - 1];
  }

  private next(): Token {
    const t = this.peek();
    if (this.i < this.tokens.length - 1) this.i++;
    return t;
  }

  private at(kind: string, text?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (text === undefined || t.text === text);
  }

  private atIdent(text: string): boolean {
    return this.at('ident', text);
  }

  private expect(kind: string, text?: string): Token {
    if (this.at(kind, text)) return this.next();
    const t = this.peek();
    this.error(`Expected ${text ?? kind}, got "${t.text || t.kind}"`);
    return t;
  }

  private expectIdent(text?: string): Token {
    return this.expect('ident', text);
  }

  private expectPunct(text: string): Token {
    return this.expect('punct', text);
  }

  private error(message: string): void {
    const t = this.peek();
    this.diagnostics.push({ message, range: t.range });
  }

  /** Skip tokens until we hit one of the given punctuation chars or eof */
  private skipTo(...puncts: string[]): void {
    while (!this.at('eof')) {
      if (this.peek().kind === 'punct' && puncts.includes(this.peek().text)) return;
      this.next();
    }
  }

  private identFromToken(t: Token): ast.Ident {
    return { name: t.text, range: t.range };
  }

  // ─── File ────────────────────────────────────────────────

  parseFile(): ast.ProtoFile {
    const file: ast.ProtoFile = {
      syntax: null,
      package: null,
      imports: [],
      options: [],
      definitions: [],
      diagnostics: [],
    };

    while (!this.at('eof')) {
      if (this.atIdent('syntax')) {
        file.syntax = this.parseSyntax();
      } else if (this.atIdent('package')) {
        file.package = this.parsePackage();
      } else if (this.atIdent('import')) {
        file.imports.push(this.parseImport());
      } else if (this.atIdent('option')) {
        file.options.push(this.parseOption());
      } else if (this.atIdent('message')) {
        file.definitions.push(this.parseMessage());
      } else if (this.atIdent('enum')) {
        file.definitions.push(this.parseEnum());
      } else if (this.atIdent('service')) {
        file.definitions.push(this.parseService());
      } else {
        this.error(`Unexpected token "${this.peek().text}"`);
        this.next();
      }
    }

    file.diagnostics = this.diagnostics;
    return file;
  }

  // ─── Syntax ──────────────────────────────────────────────

  private parseSyntax(): string | null {
    this.expectIdent('syntax');
    this.expectPunct('=');
    const val = this.peek();
    if (val.kind === 'string') {
      this.next();
      this.expectPunct(';');
      return val.text;
    }
    this.error('Expected string after syntax =');
    this.skipTo(';');
    if (this.at('punct', ';')) this.next();
    return null;
  }

  // ─── Package ─────────────────────────────────────────────

  private parsePackage(): ast.Ident {
    this.expectIdent('package');
    const name = this.expectIdent();
    this.expectPunct(';');
    return this.identFromToken(name);
  }

  // ─── Import ──────────────────────────────────────────────

  private parseImport(): ast.ImportStatement {
    const start = this.expectIdent('import');
    let modifier: 'weak' | 'public' | null = null;
    if (this.atIdent('weak') || this.atIdent('public')) {
      modifier = this.next().text as 'weak' | 'public';
    }
    const pathToken = this.peek();
    let path = '';
    if (pathToken.kind === 'string') {
      path = pathToken.text;
      this.next();
    } else {
      this.error('Expected import path string');
    }
    this.expectPunct(';');
    return { path, modifier, range: { start: start.range.start, end: this.peek().range.start } };
  }

  // ─── Option ──────────────────────────────────────────────

  private parseOption(): ast.OptionStatement {
    const start = this.expectIdent('option');
    let name = '';
    // option name can be (custom.option) or simple.name
    if (this.at('punct', '(')) {
      this.next();
      name = '(' + this.expectIdent().text + ')';
      this.expectPunct(')');
      if (this.at('punct', '.')) {
        this.next();
        name += '.' + this.expectIdent().text;
      }
    } else {
      name = this.expectIdent().text;
    }
    this.expectPunct('=');
    const val = this.next();
    this.expectPunct(';');
    return { name, value: val.text, range: { start: start.range.start, end: this.peek().range.start } };
  }

  // ─── Message ─────────────────────────────────────────────

  private parseMessage(): ast.MessageDef {
    const start = this.expectIdent('message');
    const name = this.identFromToken(this.expectIdent());
    this.expectPunct('{');

    const msg: ast.MessageDef = {
      kind: 'message',
      name,
      fields: [],
      nestedMessages: [],
      nestedEnums: [],
      oneofs: [],
      options: [],
      reserved: [],
      range: { start: start.range.start, end: start.range.end },
    };

    while (!this.at('punct', '}') && !this.at('eof')) {
      if (this.atIdent('message')) {
        msg.nestedMessages.push(this.parseMessage());
      } else if (this.atIdent('enum')) {
        msg.nestedEnums.push(this.parseEnum());
      } else if (this.atIdent('oneof')) {
        msg.oneofs.push(this.parseOneof());
      } else if (this.atIdent('map')) {
        msg.fields.push(this.parseMapField());
      } else if (this.atIdent('reserved')) {
        msg.reserved.push(this.parseReserved());
      } else if (this.atIdent('option')) {
        msg.options.push(this.parseOption());
      } else if (this.atIdent('repeated') || this.at('ident')) {
        msg.fields.push(this.parseNormalField());
      } else {
        this.error(`Unexpected token "${this.peek().text}" in message body`);
        this.skipTo(';', '}');
        if (this.at('punct', ';')) this.next();
      }
    }

    const end = this.expectPunct('}');
    msg.range = { start: start.range.start, end: end.range.end };
    return msg;
  }

  // ─── Fields ──────────────────────────────────────────────

  private parseNormalField(): ast.NormalField {
    let label: 'repeated' | null = null;
    let startToken = this.peek();

    if (this.atIdent('repeated')) {
      label = 'repeated';
      startToken = this.next();
    }

    const type = this.identFromToken(this.expectIdent());
    const name = this.identFromToken(this.expectIdent());
    this.expectPunct('=');
    const numToken = this.expect('number');
    this.expectPunct(';');

    return {
      kind: 'field',
      label,
      type,
      name,
      fieldNumber: parseInt(numToken.text, 10),
      range: { start: startToken.range.start, end: this.peek().range.start },
    };
  }

  private parseMapField(): ast.MapField {
    const start = this.expectIdent('map');
    this.expectPunct('<');
    const keyType = this.identFromToken(this.expectIdent());
    this.expectPunct(',');
    const valueType = this.identFromToken(this.expectIdent());
    this.expectPunct('>');
    const name = this.identFromToken(this.expectIdent());
    this.expectPunct('=');
    const numToken = this.expect('number');
    this.expectPunct(';');

    return {
      kind: 'map',
      keyType,
      valueType,
      name,
      fieldNumber: parseInt(numToken.text, 10),
      range: { start: start.range.start, end: this.peek().range.start },
    };
  }

  private parseOneof(): ast.OneofDef {
    const start = this.expectIdent('oneof');
    const name = this.identFromToken(this.expectIdent());
    this.expectPunct('{');

    const fields: ast.NormalField[] = [];
    while (!this.at('punct', '}') && !this.at('eof')) {
      if (this.at('ident')) {
        const type = this.identFromToken(this.expectIdent());
        const fieldName = this.identFromToken(this.expectIdent());
        this.expectPunct('=');
        const numToken = this.expect('number');
        this.expectPunct(';');
        fields.push({
          kind: 'field',
          label: null,
          type,
          name: fieldName,
          fieldNumber: parseInt(numToken.text, 10),
          range: { start: type.range.start, end: this.peek().range.start },
        });
      } else {
        this.error(`Unexpected token in oneof body`);
        this.skipTo(';', '}');
        if (this.at('punct', ';')) this.next();
      }
    }

    const end = this.expectPunct('}');
    return { name, fields, range: { start: start.range.start, end: end.range.end } };
  }

  private parseReserved(): ast.ReservedDef {
    const start = this.expectIdent('reserved');
    const entries: (number | string)[] = [];

    while (!this.at('punct', ';') && !this.at('eof')) {
      if (this.at('number')) {
        entries.push(parseInt(this.next().text, 10));
        // handle ranges like "1 to 5" — just consume "to N"
        if (this.atIdent('to')) {
          this.next();
          if (this.at('number')) this.next();
        }
      } else if (this.peek().kind === 'string') {
        entries.push(this.next().text);
      } else if (this.at('punct', ',')) {
        this.next();
      } else {
        break;
      }
    }

    const end = this.expectPunct(';');
    return { entries, range: { start: start.range.start, end: end.range.end } };
  }

  // ─── Enum ────────────────────────────────────────────────

  private parseEnum(): ast.EnumDef {
    const start = this.expectIdent('enum');
    const name = this.identFromToken(this.expectIdent());
    this.expectPunct('{');

    const enumDef: ast.EnumDef = {
      kind: 'enum',
      name,
      values: [],
      options: [],
      range: { start: start.range.start, end: start.range.end },
    };

    while (!this.at('punct', '}') && !this.at('eof')) {
      if (this.atIdent('option')) {
        enumDef.options.push(this.parseOption());
      } else if (this.atIdent('reserved')) {
        this.parseReserved(); // consume but don't store for enums (simplification)
      } else if (this.at('ident')) {
        const valueName = this.identFromToken(this.expectIdent());
        this.expectPunct('=');
        const numToken = this.expect('number');
        this.expectPunct(';');
        enumDef.values.push({
          name: valueName,
          number: parseInt(numToken.text, 10),
          range: { start: valueName.range.start, end: this.peek().range.start },
        });
      } else {
        this.error(`Unexpected token in enum body`);
        this.skipTo(';', '}');
        if (this.at('punct', ';')) this.next();
      }
    }

    const end = this.expectPunct('}');
    enumDef.range = { start: start.range.start, end: end.range.end };
    return enumDef;
  }

  // ─── Service ─────────────────────────────────────────────

  private parseService(): ast.ServiceDef {
    const start = this.expectIdent('service');
    const name = this.identFromToken(this.expectIdent());
    this.expectPunct('{');

    const svc: ast.ServiceDef = {
      kind: 'service',
      name,
      rpcs: [],
      options: [],
      range: { start: start.range.start, end: start.range.end },
    };

    while (!this.at('punct', '}') && !this.at('eof')) {
      if (this.atIdent('rpc')) {
        svc.rpcs.push(this.parseRpc());
      } else if (this.atIdent('option')) {
        svc.options.push(this.parseOption());
      } else {
        this.error(`Unexpected token in service body`);
        this.skipTo(';', '}');
        if (this.at('punct', ';')) this.next();
      }
    }

    const end = this.expectPunct('}');
    svc.range = { start: start.range.start, end: end.range.end };
    return svc;
  }

  private parseRpc(): ast.RpcDef {
    const start = this.expectIdent('rpc');
    const name = this.identFromToken(this.expectIdent());
    this.expectPunct('(');
    let inputStream = false;
    if (this.atIdent('stream')) {
      inputStream = true;
      this.next();
    }
    const inputType = this.identFromToken(this.expectIdent());
    this.expectPunct(')');
    this.expectIdent('returns');
    this.expectPunct('(');
    let outputStream = false;
    if (this.atIdent('stream')) {
      outputStream = true;
      this.next();
    }
    const outputType = this.identFromToken(this.expectIdent());
    const end = this.expectPunct(')');

    // rpc can end with ; or { ... }
    if (this.at('punct', '{')) {
      this.next();
      this.skipTo('}');
      if (this.at('punct', '}')) this.next();
    } else {
      this.expectPunct(';');
    }

    return {
      name,
      inputType,
      inputStream,
      outputType,
      outputStream,
      range: { start: start.range.start, end: end.range.end },
    };
  }
}
