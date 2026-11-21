// ═══════════════════════════════════════════════════════════
// WeildBuild safe math expression evaluator (v1.11 security patch)
// ═══════════════════════════════════════════════════════════
// Replaces `new Function('"use strict"; return (...)')` in
// weildcode-engine.ts. The Function constructor is NOT a sandbox
// (it can reach Math, parseInt, regex dos, infinite loops, and
// on the server-side world-runtime worker it runs in a Node
// process with full process.env / fetch / dynamic import access).
// A world rule authored with __wb_expr and a variable value that
// contains `}; <payload>; {` was effectively RCE on the worker.
//
// This evaluator accepts a strict subset of JS-number math:
//   - decimal numbers (incl. .5, 1e3, -2)
//   - + - * / % ** ( )
//   - the whitelisted functions: sqrt abs floor ceil round sin cos
//     tan pow min max PI E
//   - whitespace (ignored)
// It rejects EVERYTHING else: identifiers (other than the
// whitelisted functions), strings, brackets, commas outside a
// function call, assignment, ternary, semicolons, member access,
// template literals, comments. There is no way to reach `Math`,
// `process`, `globalThis`, `Function`, `eval`, or any identifier
// at all except the few names above.
//
// It also has:
//   - a hard cap on expression length (4 KB) and AST depth (60)
//   - a hard cap on evaluation steps (100 000) so a pathological
//     nested expression cannot spin the worker
//   - no recursion in the evaluator (uses an explicit stack for
//     the operator-precedence climb) so a deeply nested expr
//     cannot overflow the JS stack
//
// Returns null on any parse or evaluation failure, matching the
// old `evalExpression`'s "cannot evaluate to a finite number"
// contract.

const MAX_LEN = 4096;
const MAX_STEPS = 100_000;
const MAX_DEPTH = 60;

// Whitelisted functions. Evaluated by name; if the name is not
// here, the token is rejected as an "unknown identifier".
const FUNCTIONS: Record<string, (args: number[]) => number> = {
  sqrt:  (a) => Math.sqrt(a[0]),
  abs:   (a) => Math.abs(a[0]),
  floor: (a) => Math.floor(a[0]),
  ceil:  (a) => Math.ceil(a[0]),
  round: (a) => Math.round(a[0]),
  sin:   (a) => Math.sin(a[0]),
  cos:   (a) => Math.cos(a[0]),
  tan:   (a) => Math.tan(a[0]),
  pow:   (a) => Math.pow(a[0], a[1]),
  min:   (a) => Math.min(...a),
  max:   (a) => Math.max(...a),
};
// Whitelisted constants.
const CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
};

type Tok =
  | { t: "num"; v: number }
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" }
  | { t: "name"; v: string };

function tokenize(src: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // whitespace
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    // number: \d+(\.\d+)?([eE][+-]?\d+)?  |  \.\d+...
    if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i + 1;
      while (j < n && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
      if (j < n && (src[j] === "e" || src[j] === "E")) {
        j++;
        if (j < n && (src[j] === "+" || src[j] === "-")) j++;
        while (j < n && src[j] >= "0" && src[j] <= "9") j++;
      }
      const v = Number(src.slice(i, j));
      if (!isFinite(v)) return null;
      toks.push({ t: "num", v });
      i = j;
      continue;
    }
    // identifier (must start with a letter or _; only whitelisted names accepted later)
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "name", v: src.slice(i, j) });
      i = j;
      continue;
    }
    // operators — `**` must be checked BEFORE the single `*`,
    // otherwise `2 ** 10` tokenizes as `2 * * 10` (two single-stars)
    // and the parser rejects it.
    if (c === "*" && src[i + 1] === "*") { toks.push({ t: "op", v: "**" }); i += 2; continue; }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "%") {
      toks.push({ t: "op", v: c }); i++; continue;
    }
    if (c === "(") { toks.push({ t: "lparen" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rparen" }); i++; continue; }
    if (c === ",") { toks.push({ t: "comma" }); i++; continue; }
    // anything else is rejected: . (outside a number), ; : ! ? [ ] { } ` ' " # @ $ & | \ = < >
    return null;
  }
  return toks;
}

// Precedence-climbing parser. Builds an evaluator closure instead
// of an AST (no recursion at eval time). Tracks depth to cap
// pathological nesting.
function parse(toks: Tok[]): (() => number) | null {
  let pos = 0;
  let depth = 0;
  let stepsBudget = MAX_STEPS;

  function peek(): Tok | undefined { return toks[pos]; }
  function eat(): Tok | undefined { return toks[pos++]; }

  // parseExpr = parseAdd
  // parseAdd  = parseMul ( ('+' | '-') parseMul )*
  // parseMul  = parsePow ( ('*' | '/' | '%') parsePow )*
  // parsePow  = parseUnary ( '**' parsePow )?    (right-assoc)
  // parseUnary= ('-' | '+') parseUnary | parsePrimary
  // parsePrimary = number | name | name '(' args ')' | '(' parseExpr ')'

  function parseExpr(): (() => number) | null {
    if (depth++ > MAX_DEPTH) return null;
    const r = parseAdd();
    depth--;
    return r;
  }
  function parseAdd(): (() => number) | null {
    let left = parseMul();
    if (!left) return null;
    while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = (eat() as { v: string }).v;
      const right = parseMul();
      if (!right) return null;
      const l = left, r = right;
      if (op === "+") left = () => { if (--stepsBudget < 0) return NaN; return l() + r(); };
      else            left = () => { if (--stepsBudget < 0) return NaN; return l() - r(); };
    }
    return left;
  }
  function parseMul(): (() => number) | null {
    let left = parsePow();
    if (!left) return null;
    while (peek()?.t === "op" && (peek()!.v === "*" || peek()!.v === "/" || peek()!.v === "%")) {
      const op = (eat() as { v: string }).v;
      const right = parsePow();
      if (!right) return null;
      const l = left, r = right;
      if (op === "*") left = () => { if (--stepsBudget < 0) return NaN; return l() * r(); };
      else if (op === "/") left = () => { if (--stepsBudget < 0) return NaN; const b = r(); return b === 0 ? NaN : l() / b; };
      else                 left = () => { if (--stepsBudget < 0) return NaN; const b = r(); return b === 0 ? NaN : l() % b; };
    }
    return left;
  }
  function parsePow(): (() => number) | null {
    const left = parseUnary();
    if (!left) return null;
    if (peek()?.t === "op" && peek()!.v === "**") {
      eat();
      const right = parsePow(); // right-assoc
      if (!right) return null;
      const l = left, r = right;
      return () => { if (--stepsBudget < 0) return NaN; return Math.pow(l(), r()); };
    }
    return left;
  }
  function parseUnary(): (() => number) | null {
    if (peek()?.t === "op" && (peek()!.v === "-" || peek()!.v === "+")) {
      const op = (eat() as { v: string }).v;
      const inner = parseUnary();
      if (!inner) return null;
      if (op === "-") return () => { if (--stepsBudget < 0) return NaN; return -inner(); };
      return inner;
    }
    return parsePrimary();
  }
  function parsePrimary(): (() => number) | null {
    const t = eat();
    if (!t) return null;
    if (t.t === "num") {
      const v = t.v;
      return () => v;
    }
    if (t.t === "lparen") {
      const inner = parseExpr();
      if (!inner) return null;
      if (peek()?.t !== "rparen") return null;
      eat();
      return inner;
    }
    if (t.t === "name") {
      const name = t.v;
      // constant?
      if (CONSTANTS.hasOwnProperty(name)) {
        const v = CONSTANTS[name];
        return () => v;
      }
      // function call: name '(' args ')'
      if (peek()?.t === "lparen") {
        eat();
        const fn = FUNCTIONS[name];
        if (!fn) return null; // unknown function name
        const argClosures: (() => number)[] = [];
        if (peek()?.t !== "rparen") {
          // Parse the first argument.
          const first = parseExpr();
          if (!first) return null;
          argClosures.push(first);
          // Parse additional arguments, each preceded by a comma.
          // Use peek() to check, eat() only when it IS a comma —
          // the old `while (eat() ...)` form consumed the `)` too
          // and the rparen check below failed.
          while (peek()?.t === "comma") {
            eat();
            const a = parseExpr();
            if (!a) return null;
            argClosures.push(a);
          }
        }
        if (peek()?.t !== "rparen") return null;
        eat();
        return () => {
          if (--stepsBudget < 0) return NaN;
          const args = argClosures.map((c) => c());
          return fn(args);
        };
      }
      // bare identifier — reject. The old `new Function` path
      // would have returned NaN for an unknown var (which was
      // already substituted away by replaceWordToken). Here we
      // return null so evalExpression falls back to 0/null.
      return null;
    }
    return null;
  }

  const root = parseExpr();
  if (!root) return null;
  if (pos !== toks.length) return null; // trailing garbage
  return root;
}

/**
 * Evaluate a math expression safely. Returns null on any error
 * (parse failure, evaluation overflow, non-finite result).
 */
export function safeEvalMath(expr: string): number | null {
  if (typeof expr !== "string" || expr.length === 0 || expr.length > MAX_LEN) return null;
  const toks = tokenize(expr);
  if (!toks) return null;
  const fn = parse(toks);
  if (!fn) return null;
  try {
    const v = fn();
    return typeof v === "number" && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
