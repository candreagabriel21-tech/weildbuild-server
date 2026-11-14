// ═══════════════════════════════════════════════════════════════════
// WeLua — Stage 2: the parser (Lua 5.4-flavoured recursive descent)
// ═══════════════════════════════════════════════════════════════════
// Produces a plain AST. The interpreter walks this tree with generator
// functions so any native builtin can suspend the whole script (that is
// how welu.wait works without threads or async/await in user code).

import { Token, TokenType, tokenize, LuaSyntaxError } from './lua-lexer';

// ─── AST node types ───

export type Expr =
  | { kind: 'Nil'; line: number }
  | { kind: 'True'; line: number }
  | { kind: 'False'; line: number }
  | { kind: 'Num'; value: string; line: number }   // text; interpreted at runtime (hex vs decimal)
  | { kind: 'Str'; value: string; line: number }
  | { kind: 'Vararg'; line: number }
  | { kind: 'Var'; name: string; line: number }
  | { kind: 'Paren'; inner: Expr; line: number }   // (expr) — truncates multi-values to one
  | { kind: 'Index'; obj: Expr; key: Expr; line: number }
  | { kind: 'Call'; fn: Expr; args: Expr[]; line: number }
  | { kind: 'Method'; obj: Expr; name: string; args: Expr[]; line: number }
  | { kind: 'Func'; func: FuncBody; line: number }
  | { kind: 'Bin'; op: string; left: Expr; right: Expr; line: number }
  | { kind: 'Un'; op: string; operand: Expr; line: number }
  | { kind: 'Table'; entries: TableEntry[]; line: number };

export interface TableEntry {
  key?: Expr;       // absent = positional entry
  value: Expr;
}

export interface FuncBody {
  params: string[];
  isVararg: boolean;
  body: Stat[];
  line: number;
  /** function name path for error messages (a.b.c / a:b) */
  name?: string;
}

export type Stat =
  | { kind: 'Local'; names: string[]; exprs: Expr[]; line: number }
  | { kind: 'Assign'; targets: Expr[]; exprs: Expr[]; line: number }
  | { kind: 'ExprStat'; expr: Expr; line: number }
  | { kind: 'If'; clauses: Array<{ cond: Expr; body: Stat[] }>; elseBody: Stat[] | null; line: number }
  | { kind: 'While'; cond: Expr; body: Stat[]; line: number }
  | { kind: 'Repeat'; body: Stat[]; cond: Expr; line: number }
  | { kind: 'NumFor'; varName: string; start: Expr; limit: Expr; step: Expr | null; body: Stat[]; line: number }
  | { kind: 'GenFor'; names: string[]; exprs: Expr[]; body: Stat[]; line: number }
  | { kind: 'FuncDecl'; target: Expr; func: FuncBody; line: number } // function a.b.c:d() ...
  | { kind: 'LocalFunc'; name: string; func: FuncBody; line: number }
  | { kind: 'Return'; exprs: Expr[]; line: number }
  | { kind: 'Break'; line: number }
  | { kind: 'Do'; body: Stat[]; line: number };

export interface Chunk {
  body: Stat[];
}

// ─── Parser ───

const BLOCK_ENDERS = new Set(['end', 'else', 'elseif', 'until']);

// Binary operator precedence, mirroring Lua 5.4 (higher binds tighter).
// or < and < comparisons < | < ~ < & < shift < .. < +- < */ // % < unary < ^
const BIN_PREC: Record<string, [number, number]> = {
  'or': [1, 1],
  'and': [2, 2],
  '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
  '|': [4, 4],
  '~': [5, 5],
  '&': [6, 6],
  '<<': [7, 7], '>>': [7, 7],
  '..': [9, 8],   // right-associative
  '+': [10, 10], '-': [10, 10],
  '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11],
  '^': [14, 13],  // right-associative, binds tighter than unary
};
const UNARY_PREC = 12;

export class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  // ── token helpers ──

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }
  private check(type: TokenType, value?: string): boolean {
    const t = this.peek();
    if (t.type !== type) return false;
    return value === undefined || t.value === value;
  }
  private checkOp(value: string): boolean { return this.check('op', value); }
  private checkKw(value: string): boolean { return this.check('keyword', value); }
  private acceptOp(value: string): boolean {
    if (this.checkOp(value)) { this.next(); return true; }
    return false;
  }
  private acceptKw(value: string): boolean {
    if (this.checkKw(value)) { this.next(); return true; }
    return false;
  }
  private expectOp(value: string): Token {
    if (!this.checkOp(value)) this.error(`'${value}' expected`);
    return this.next();
  }
  private expectKw(value: string): Token {
    if (!this.checkKw(value)) this.error(`'${value}' expected`);
    return this.next();
  }
  private expectName(): Token {
    if (!this.check('name')) this.error('<name> expected');
    return this.next();
  }
  private error(message: string): never {
    const t = this.peek();
    throw new LuaSyntaxError(`${message} near '${t.type === 'eof' ? '<eof>' : t.value}'`, t.line);
  }

  // ── entry point ──

  parseChunk(): Chunk {
    const body = this.parseBlock();
    if (this.peek().type !== 'eof') this.error('unexpected symbol');
    return { body };
  }

  private parseBlock(): Stat[] {
    const stats: Stat[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') break;
      if (t.type === 'keyword' && BLOCK_ENDERS.has(t.value)) break;
      // retstat: `return` is always the LAST statement of a block
      if (t.type === 'keyword' && t.value === 'return') {
        stats.push(this.parseStatement()!);
        break;
      }
      const stat = this.parseStatement();
      if (stat) stats.push(stat);
      // statements can be separated by ';' (consumed inside parseStatement)
    }
    return stats;
  }

  /** A block that ends with a keyword closer (do..end, if..end, ...). */
  private parseClosedBlock(closer: string): Stat[] {
    const body = this.parseBlock();
    this.expectKw(closer);
    return body;
  }

  private parseStatement(): Stat | null {
    const t = this.peek();
    const line = t.line;

    if (this.acceptOp(';')) return null;

    if (t.type === 'keyword') {
      switch (t.value) {
        case 'if': {
          this.next();
          const clauses: Array<{ cond: Expr; body: Stat[] }> = [];
          const cond = this.parseExpr();
          this.expectKw('then');
          clauses.push({ cond, body: this.parseBlock() });
          let elseBody: Stat[] | null = null;
          for (;;) {
            if (this.acceptKw('elseif')) {
              const c = this.parseExpr();
              this.expectKw('then');
              clauses.push({ cond: c, body: this.parseBlock() });
              continue;
            }
            if (this.acceptKw('else')) {
              elseBody = this.parseBlock();
            }
            this.expectKw('end');
            break;
          }
          return { kind: 'If', clauses, elseBody, line };
        }
        case 'while': {
          this.next();
          const cond = this.parseExpr();
          this.expectKw('do');
          const body = this.parseClosedBlock('end');
          return { kind: 'While', cond, body, line };
        }
        case 'repeat': {
          this.next();
          const body = this.parseBlock();
          this.expectKw('until');
          const cond = this.parseExpr();
          return { kind: 'Repeat', body, cond, line };
        }
        case 'do': {
          this.next();
          const body = this.parseClosedBlock('end');
          return { kind: 'Do', body, line };
        }
        case 'for': {
          this.next();
          const first = this.expectName();
          if (this.acceptOp('=')) {
            // numeric for
            const start = this.parseExpr();
            this.expectOp(',');
            const limit = this.parseExpr();
            let step: Expr | null = null;
            if (this.acceptOp(',')) step = this.parseExpr();
            this.expectKw('do');
            const body = this.parseClosedBlock('end');
            return { kind: 'NumFor', varName: first.value, start, limit, step, body, line };
          }
          // generic for
          const names = [first.value];
          while (this.acceptOp(',')) names.push(this.expectName().value);
          this.expectKw('in');
          const exprs = this.parseExprList();
          this.expectKw('do');
          const body = this.parseClosedBlock('end');
          return { kind: 'GenFor', names, exprs, body, line };
        }
        case 'function': {
          this.next();
          // function a.b.c:d() ... — build the target Index chain
          let target: Expr = { kind: 'Var', name: this.expectName().value, line };
          let name = target.name;
          let isMethod = false;
          while (this.acceptOp('.')) {
            const keyTok = this.expectName();
            target = { kind: 'Index', obj: target, key: { kind: 'Str', value: keyTok.value, line: keyTok.line }, line: keyTok.line };
            name += `.${keyTok.value}`;
          }
          if (this.acceptOp(':')) {
            const keyTok = this.expectName();
            target = { kind: 'Index', obj: target, key: { kind: 'Str', value: keyTok.value, line: keyTok.line }, line: keyTok.line };
            name += `:${keyTok.value}`;
            isMethod = true;
          }
          const func = this.parseFuncBody(isMethod, name, line);
          return { kind: 'FuncDecl', target, func, line };
        }
        case 'local': {
          this.next();
          if (this.acceptKw('function')) {
            const nameTok = this.expectName();
            const func = this.parseFuncBody(false, nameTok.value, nameTok.line);
            return { kind: 'LocalFunc', name: nameTok.value, func, line };
          }
          const names = [this.expectName().value];
          while (this.acceptOp(',')) names.push(this.expectName().value);
          let exprs: Expr[] = [];
          if (this.acceptOp('=')) exprs = this.parseExprList();
          return { kind: 'Local', names, exprs, line };
        }
        case 'return': {
          this.next();
          let exprs: Expr[] = [];
          if (!this.checkOp(';') && !this.checkKw('end') && !this.checkKw('else')
            && !this.checkKw('elseif') && !this.checkKw('until') && this.peek().type !== 'eof') {
            exprs = this.parseExprList();
          }
          this.acceptOp(';');
          return { kind: 'Return', exprs, line };
        }
        case 'break': {
          this.next();
          this.acceptOp(';');
          return { kind: 'Break', line };
        }
        case 'goto':
          this.error("'goto' is not supported in WeLua (use loops or functions instead)");
          break;
        default:
          this.error('unexpected symbol');
      }
    }

    // Expression statement or assignment: parse a suffixed expression list
    const first = this.parseSuffixedExpr();
    if (this.checkOp('=') || this.checkOp(',')) {
      const targets = [first];
      while (this.acceptOp(',')) targets.push(this.parseSuffixedExpr());
      this.expectOp('=');
      const exprs = this.parseExprList();
      for (const target of targets) {
        if (target.kind !== 'Var' && target.kind !== 'Index') {
          this.error('syntax error near assignment target');
        }
      }
      return { kind: 'Assign', targets, exprs, line };
    }
    if (first.kind !== 'Call' && first.kind !== 'Method') {
      this.error('syntax error');
    }
    this.acceptOp(';');
    return { kind: 'ExprStat', expr: first, line };
  }

  private parseFuncBody(isMethod: boolean, name: string | undefined, line: number): FuncBody {
    this.expectOp('(');
    const params: string[] = [];
    if (isMethod) params.push('self');
    let isVararg = false;
    if (!this.checkOp(')')) {
      for (;;) {
        if (this.acceptOp('...')) { isVararg = true; break; }
        params.push(this.expectName().value);
        if (!this.acceptOp(',')) break;
      }
    }
    this.expectOp(')');
    const body = this.parseClosedBlock('end');
    return { params, isVararg, body, line, name };
  }

  private parseExprList(): Expr[] {
    const list = [this.parseExpr()];
    while (this.acceptOp(',')) list.push(this.parseExpr());
    return list;
  }

  // ── expressions ──

  private parseExpr(): Expr {
    return this.parseSubExpr(0);
  }

  private parseSubExpr(limit: number): Expr {
    let left: Expr;
    const t = this.peek();
    const unOp = t.type === 'op' && (t.value === '-' || t.value === 'not' || t.value === '#' || t.value === '~')
      ? t.value
      : (t.type === 'keyword' && t.value === 'not' ? 'not' : null);
    if (unOp) {
      this.next();
      const operand = this.parseSubExpr(UNARY_PREC);
      left = { kind: 'Un', op: unOp, operand, line: t.line };
    } else {
      left = this.parseSuffixedExpr();
    }
    for (;;) {
      const opTok = this.peek();
      // 'and' / 'or' are KEYWORD tokens; every other binop is an op token.
      let opValue: string | null = null;
      if (opTok.type === 'op' && BIN_PREC[opTok.value]) opValue = opTok.value;
      else if (opTok.type === 'keyword' && (opTok.value === 'and' || opTok.value === 'or')) opValue = opTok.value;
      if (!opValue) break;
      const prec = BIN_PREC[opValue];
      if (prec[0] <= limit) break;
      this.next();
      const right = this.parseSubExpr(prec[1]);
      left = { kind: 'Bin', op: opValue, left, right, line: opTok.line };
    }
    return left;
  }

  private parsePrimaryExpr(): Expr {
    const t = this.peek();
    const line = t.line;
    switch (t.type) {
      case 'number':
        this.next();
        return { kind: 'Num', value: t.value, line };
      case 'string':
        this.next();
        return { kind: 'Str', value: t.value, line };
      case 'keyword':
        if (t.value === 'nil') { this.next(); return { kind: 'Nil', line }; }
        if (t.value === 'true') { this.next(); return { kind: 'True', line }; }
        if (t.value === 'false') { this.next(); return { kind: 'False', line }; }
        if (t.value === 'function') {
          this.next();
          return { kind: 'Func', func: this.parseFuncBody(false, undefined, line), line };
        }
        this.error('unexpected symbol');
        break;
      case 'op':
        if (t.value === '...') { this.next(); return { kind: 'Vararg', line }; }
        if (t.value === '(') {
          this.next();
          const inner = this.parseExpr();
          this.expectOp(')');
          return { kind: 'Paren', inner, line };
        }
        if (t.value === '{') {
          return this.parseTableConstructor();
        }
        this.error('unexpected symbol');
        break;
      case 'name': {
        this.next();
        return { kind: 'Var', name: t.value, line };
      }
      default:
        this.error('unexpected symbol');
    }
  }

  private parseSuffixedExpr(): Expr {
    let expr = this.parsePrimaryExpr();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op') break;
      if (t.value === '.') {
        this.next();
        const keyTok = this.expectName();
        expr = { kind: 'Index', obj: expr, key: { kind: 'Str', value: keyTok.value, line: keyTok.line }, line: keyTok.line };
        continue;
      }
      if (t.value === '[') {
        this.next();
        const key = this.parseExpr();
        this.expectOp(']');
        expr = { kind: 'Index', obj: expr, key, line: t.line };
        continue;
      }
      if (t.value === ':') {
        this.next();
        const nameTok = this.expectName();
        const args = this.parseCallArgs();
        expr = { kind: 'Method', obj: expr, name: nameTok.value, args, line: nameTok.line };
        continue;
      }
      if (t.value === '(' || t.value === '{' || t.value === 'string') {
        const args = this.parseCallArgs();
        expr = { kind: 'Call', fn: expr, args, line: t.line };
        continue;
      }
      break;
    }
    return expr;
  }

  /** Arguments after a call: (a, b), a single string literal, or a table. */
  private parseCallArgs(): Expr[] {
    const t = this.peek();
    if (t.type === 'string') { this.next(); return [{ kind: 'Str', value: t.value, line: t.line }]; }
    if (t.type === 'op' && t.value === '{') {
      return [this.parseTableConstructor()];
    }
    this.expectOp('(');
    const args: Expr[] = [];
    if (!this.checkOp(')')) {
      for (;;) {
        args.push(this.parseExpr());
        if (!this.acceptOp(',')) break;
      }
    }
    this.expectOp(')');
    return args;
  }

  private parseTableConstructor(): Expr {
    const openTok = this.expectOp('{');
    const entries: TableEntry[] = [];
    for (;;) {
      if (this.checkOp('}')) break;
      if (this.checkOp('[')) {
        this.next();
        const key = this.parseExpr();
        this.expectOp(']');
        this.expectOp('=');
        entries.push({ key, value: this.parseExpr() });
      } else if (this.check('name') && this.peek(1).type === 'op' && this.peek(1).value === '=') {
        const nameTok = this.next();
        this.next(); // '='
        entries.push({ key: { kind: 'Str', value: nameTok.value, line: nameTok.line }, value: this.parseExpr() });
      } else {
        entries.push({ value: this.parseExpr() });
      }
      if (!this.acceptOp(',') && !this.acceptOp(';')) break;
    }
    this.expectOp('}');
    return { kind: 'Table', entries, line: openTok.line };
  }
}

/** Parse WeLua source into an AST chunk (throws LuaSyntaxError). */
export function parseLua(source: string): Chunk {
  return new Parser(source).parseChunk();
}

/** Quick syntax check used by the editor: returns an error or null. */
export function checkLuaSyntax(source: string): { message: string; line: number } | null {
  try {
    parseLua(source);
    return null;
  } catch (err) {
    if (err instanceof LuaSyntaxError) return { message: err.message, line: err.line };
    return { message: String((err as Error)?.message ?? err), line: 0 };
  }
}
