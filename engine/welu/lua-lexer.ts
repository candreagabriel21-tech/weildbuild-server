// ═══════════════════════════════════════════════════════════════════
// WeLua — the WeildBuild scripting language (Lua dialect)
// ─── Stage 1: the lexer ───
// ═══════════════════════════════════════════════════════════════════
// WeLua is real Lua (5.4-flavoured) so players can code with actual
// code. The implementation is a self-contained tree-walking interpreter
// written as JS generator functions: any call can `yield` a suspend
// signal, which is how `welu.wait(1)` freezes a script WITHOUT freezing
// the game (the runtime scheduler resumes the generator later).
//
// This file tokenizes source text. It supports the full token set the
// parser needs: names, decimal + hex numbers, short + long strings,
// short + long comments, and every Lua operator.

export type TokenType =
  | 'name'
  | 'number'
  | 'string'
  | 'keyword'
  | 'op'
  | 'eof';

export interface Token {
  type: TokenType;
  /** The token's text (for strings: the DECODED value). */
  value: string;
  /** 1-based line of the token's first character. */
  line: number;
}

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
  'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or',
  'repeat', 'return', 'then', 'true', 'until', 'while',
]);

const OPERATORS = [
  '...', '..', '==', '~=', '<=', '>=', '<<', '>>', '//', '::',
  '+', '-', '*', '/', '%', '^', '#', '&', '~', '|', '<', '>',
  '=', '(', ')', '{', '}', '[', ']', ';', ':', ',', '.',
];

export class LuaSyntaxError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'LuaSyntaxError';
    this.line = line;
  }
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
function isNameStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isNameChar(c: string): boolean {
  return isNameStart(c) || isDigit(c);
}

/** Decode a short (quoted) string body. `raw` excludes the quotes. */
function decodeShortString(raw: string, line: number): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) throw new LuaSyntaxError('unfinished string escape', line);
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case '\n': out += '\n'; break; // escaped literal newline
      case 'x': {
        const hex = raw.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new LuaSyntaxError('hexadecimal digit expected in \\x escape', line);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case 'z': {
        // \z skips following whitespace
        i++;
        while (i < raw.length && /\s/.test(raw[i])) i++;
        i--; // outer loop increments
        break;
      }
      default: {
        if (isDigit(n)) {
          // up to 3 decimal digits
          let num = '';
          let j = i;
          while (j < raw.length && isDigit(raw[j]) && num.length < 3) { num += raw[j]; j++; }
          out += String.fromCharCode(parseInt(num, 10));
          i = j - 1;
        } else if (n === 'u') {
          // \u{XXXX}
          const m = /^\{([0-9a-fA-F]+)\}/.exec(raw.slice(i + 1));
          if (!m) throw new LuaSyntaxError('missing { in \\u{xxxx} escape', line);
          const code = parseInt(m[1], 16);
          out += String.fromCodePoint(code);
          i += m[0].length;
        } else {
          throw new LuaSyntaxError(`invalid escape sequence '\\${n}'`, line);
        }
      }
    }
  }
  return out;
}

/** Tokenize Lua source. Throws LuaSyntaxError on malformed input. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  const pushToken = (type: TokenType, value: string, tokenLine: number) => {
    tokens.push({ type, value, line: tokenLine });
  };

  while (i < n) {
    const c = source[i];

    // ── whitespace ──
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f') { i++; continue; }

    // ── comments ──
    if (c === '-' && source[i + 1] === '-') {
      i += 2;
      // long comment --[[ ... ]]
      if (source[i] === '[' && (source[i + 1] === '[' || source[i + 1] === '=')) {
        let level = 0;
        let j = i + 1;
        while (source[j] === '=') { level++; j++; }
        if (source[j] === '[') {
          const close = `]${'='.repeat(level)}]`;
          const end = source.indexOf(close, j + 1);
          if (end === -1) throw new LuaSyntaxError('unfinished long comment', line);
          // count newlines inside
          for (let k = i; k < end; k++) if (source[k] === '\n') line++;
          line++; // the opening [[ eats the newline right after it (Lua semantics)
          i = end + close.length;
          continue;
        }
        // not a long comment after all — treat as line comment
      }
      // line comment
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // ── long string [[...]] / [=[...]=] ──
    if (c === '[' && (source[i + 1] === '[' || source[i + 1] === '=')) {
      let level = 0;
      let j = i + 1;
      while (source[j] === '=') { level++; j++; }
      if (source[j] === '[') {
        const startLine = line;
        const close = `]${'='.repeat(level)}]`;
        const end = source.indexOf(close, j + 1);
        if (end === -1) throw new LuaSyntaxError('unfinished long string', startLine);
        let body = source.slice(j + 1, end);
        // Lua skips a newline immediately after the opening bracket
        if (body.startsWith('\r\n')) body = body.slice(2);
        else if (body.startsWith('\n')) body = body.slice(1);
        for (let k = i; k < end; k++) if (source[k] === '\n') line++;
        pushToken('string', body, startLine);
        i = end + close.length;
        continue;
      }
      // else fall through: '[' operator
    }

    // ── names / keywords ──
    if (isNameStart(c)) {
      const startLine = line;
      let j = i;
      while (j < n && isNameChar(source[j])) j++;
      const word = source.slice(i, j);
      pushToken(KEYWORDS.has(word) ? 'keyword' : 'name', word, startLine);
      i = j;
      continue;
    }

    // ── numbers ──
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      const startLine = line;
      let j = i;
      let text = '';
      if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        j = i + 2;
        text = '0x';
        while (j < n && isHexDigit(source[j])) { text += source[j]; j++; }
        // hex fraction / exponent (Lua 5.4 allows 0x1p4; keep the common part)
        if (text === '0x') throw new LuaSyntaxError('malformed hexadecimal number', startLine);
        pushToken('number', text, startLine);
        i = j;
        continue;
      }
      while (j < n && isDigit(source[j])) { text += source[j]; j++; }
      if (source[j] === '.') {
        text += '.';
        j++;
        while (j < n && isDigit(source[j])) { text += source[j]; j++; }
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        let exp = 'e';
        if (source[k] === '+' || source[k] === '-') { exp += source[k]; k++; }
        if (!isDigit(source[k])) throw new LuaSyntaxError('malformed number exponent', startLine);
        while (k < n && isDigit(source[k])) { exp += source[k]; k++; }
        text += exp;
        j = k;
      }
      pushToken('number', text, startLine);
      i = j;
      continue;
    }

    // ── short strings ──
    if (c === '"' || c === "'") {
      const startLine = line;
      const quote = c;
      let j = i + 1;
      let raw = '';
      while (j < n) {
        const ch = source[j];
        if (ch === '\\') {
          // keep escapes for the decoder (include the backslash + next char)
          raw += ch + (source[j + 1] ?? '');
          if (source[j + 1] === '\n') line++;
          j += 2;
          continue;
        }
        if (ch === quote) break;
        if (ch === '\n') throw new LuaSyntaxError('unfinished string', startLine);
        raw += ch;
        j++;
      }
      if (j >= n) throw new LuaSyntaxError('unfinished string', startLine);
      pushToken('string', decodeShortString(raw, startLine), startLine);
      i = j + 1;
      continue;
    }

    // ── operators ──
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      pushToken('op', op, line);
      i += op.length;
      continue;
    }

    throw new LuaSyntaxError(`unexpected symbol near '${c}'`, line);
  }

  pushToken('eof', '<eof>', line);
  return tokens;
}
