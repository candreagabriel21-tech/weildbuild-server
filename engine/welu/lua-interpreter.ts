// ═══════════════════════════════════════════════════════════════════
// WeLua — Stage 3: the interpreter (generator-based tree walker)
// ═══════════════════════════════════════════════════════════════════
// Every eval/exec method is a JS generator. A native builtin written as
// a generator function can `yield` a SuspendSignal; the signal bubbles
// up through every nested call to the HOST scheduler, which resumes the
// whole stack later (that is welu.wait). Everything else is a normal,
// synchronous tree-walking Lua interpreter:
//
//   • values: nil / boolean / number / string / table / function
//   • closures with proper upvalue cells
//   • multiple returns + varargs
//   • metatables: __index, __newindex, __call, __tostring, __pairs
//   • the standard library (base, math, string with real Lua patterns,
//     table, a sandboxed os subset) — no io / no files / no os.execute
//   • a step + wall-clock budget so an infinite loop kills ONE script,
//     never the game (FatalLuaError is not catchable by pcall)

import { Chunk, Expr, FuncBody, Stat, TableEntry, parseLua } from './lua-parser';

// ─── Values ───

export type LuaValue = null | boolean | number | string | LuaTable | LuaFunction;

export interface LuaFunction {
  /** Plain native: (interp, args) => value | value[] | void */
  native?: (interp: LuaInterpreter, args: LuaValue[]) => LuaValue | LuaValue[] | void;
  /** Suspending native (generator): can yield YieldSignal to the host. */
  nativeGen?: (interp: LuaInterpreter, args: LuaValue[]) => Generator<YieldSignal, LuaValue | LuaValue[] | void, unknown>;
  /** Interpreted function body + the scope it was created in. */
  body?: FuncBody;
  closure?: Scope | null;
  name?: string;
}

export class LuaTable {
  map = new Map<LuaValue, LuaValue>();
  metatable: LuaTable | null = null;
  /** Cached key order for next()/pairs(); invalidated on structural change. */
  private keysCache: LuaValue[] | null = null;

  get(key: LuaValue): LuaValue {
    return this.map.get(this.normKey(key)) ?? null;
  }
  set(key: LuaValue, value: LuaValue): void {
    const k = this.normKey(key);
    if (value === null) {
      if (this.map.delete(k)) this.keysCache = null;
    } else {
      if (!this.map.has(k)) this.keysCache = null;
      this.map.set(k, value);
    }
  }
  has(key: LuaValue): boolean {
    return this.map.has(this.normKey(key));
  }
  /** Normalize keys: -0 → 0; NaN rejected (matches Lua). */
  private normKey(key: LuaValue): LuaValue {
    if (typeof key === 'number') {
      if (Number.isNaN(key)) throw new LuaError('table index is NaN');
      return key === 0 ? 0 : key;
    }
    return key;
  }
  /** Contiguous array border (Lua 5.4's luaH_getn: doubling + binary search). */
  length(): number {
    if (!this.map.has(1)) return 0;
    let j = 1;
    while (this.map.has(j * 2)) j *= 2;
    // j is present and 2j is absent — binary-search a border in (j, 2j]
    let lo = j, hi = j * 2;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.map.has(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }
  keys(): LuaValue[] {
    if (!this.keysCache) this.keysCache = [...this.map.keys()];
    return this.keysCache;
  }
  /** Snapshot entries in insertion order. */
  entries(): Array<[LuaValue, LuaValue]> {
    return [...this.map.entries()];
  }
}

// ─── Scopes (closures capture cells by reference) ───

interface Cell { v: LuaValue }

export interface Scope {
  vars: Map<string, Cell>;
  parent: Scope | null;
  /** 'parent' = walk up for varargs; an array = this frame's varargs. */
  varargs: LuaValue[] | 'parent';
}

function newScope(parent: Scope | null, varargs?: LuaValue[]): Scope {
  return { vars: new Map(), parent, varargs: varargs ?? 'parent' };
}

function lookupCell(scope: Scope | null, name: string): Cell | null {
  for (let s = scope; s; s = s.parent) {
    const cell = s.vars.get(name);
    if (cell) return cell;
  }
  return null;
}

// ─── Errors / control-flow signals ───

/** A Lua runtime error (catchable by pcall). */
export class LuaError extends Error {
  value: LuaValue;
  line: number;
  constructor(value: LuaValue, line = 0) {
    super(typeof value === 'string' ? value : 'Lua error');
    this.name = 'LuaError';
    this.value = value;
    this.line = line;
  }
}

/** Budget exhaustion / host kill — pcall must NOT swallow this. */
export class FatalLuaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalLuaError';
  }
}

class ReturnSignal {
  constructor(public values: LuaValue[]) {}
}
class BreakSignal {}

/** What a suspending builtin yields to the host scheduler. */
export interface YieldSignal {
  type: 'wait' | 'custom';
  seconds?: number;
  payload?: unknown;
}

// ─── Interpreter ───

export interface InterpreterOptions {
  /** Wall-clock ms per host resume slice (default 100). */
  sliceMs?: number;
  /** Step cap per host resume slice (default 2,000,000). */
  maxSteps?: number;
}

export class LuaInterpreter {
  globals = new LuaTable();
  currentLine = 0;

  private steps = 0;
  private deadline = 0;
  private sliceMs: number;
  private maxSteps: number;

  constructor(opts: InterpreterOptions = {}) {
    this.sliceMs = opts.sliceMs ?? 100;
    this.maxSteps = opts.maxSteps ?? 2_000_000;
    installStdlib(this);
  }

  /** The host calls this before resuming a generator (a fresh time slice). */
  beginSlice(): void {
    this.steps = 0;
    this.deadline = performance.now() + this.sliceMs;
  }

  /** Count one AST step; kill the script when the budget is gone. */
  step(line?: number): void {
    if (line && line > 0) this.currentLine = line;
    this.steps++;
    if ((this.steps & 0x3ff) === 0) {  // check the clock every 1024 steps
      if (performance.now() > this.deadline) {
        throw new FatalLuaError(
          'WeLua script halted: it ran too long without waiting (possible infinite loop). Put welu.wait() inside loops that run forever.',
        );
      }
    }
    if (this.steps > this.maxSteps) {
      throw new FatalLuaError('WeLua script halted: step budget exceeded.');
    }
  }

  // ─── entry point ───

  *runChunk(chunk: Chunk, envScope?: Scope): Generator<YieldSignal, LuaValue[], unknown> {
    try {
      yield* this.execBlock(chunk.body, envScope ?? newScope(null));
    } catch (e) {
      if (e instanceof ReturnSignal) return e.values;
      throw e;
    }
    return [];
  }

  // ─── statements ───

  *execBlock(stats: Stat[], scope: Scope): Generator<YieldSignal, void, unknown> {
    for (const stat of stats) {
      yield* this.execStat(stat, scope);
    }
  }

  *execStat(stat: Stat, scope: Scope): Generator<YieldSignal, void, unknown> {
    this.step((stat as any).line);
    switch (stat.kind) {
      case 'Local': {
        const values = yield* this.evalExprList(stat.exprs, scope);
        stat.names.forEach((name, i) => {
          scope.vars.set(name, { v: values[i] ?? null });
        });
        return;
      }
      case 'Assign': {
        const values = yield* this.evalExprList(stat.exprs, scope);
        for (let i = 0; i < stat.targets.length; i++) {
          yield* this.assign(stat.targets[i], values[i] ?? null, scope);
        }
        return;
      }
      case 'ExprStat': {
        yield* this.evalMulti(stat.expr, scope);
        return;
      }
      case 'If': {
        for (const clause of stat.clauses) {
          const cond = yield* this.evalExpr(clause.cond, scope);
          if (this.truthy(cond)) {
            yield* this.execBlock(clause.body, newScope(scope));
            return;
          }
        }
        if (stat.elseBody) yield* this.execBlock(stat.elseBody, newScope(scope));
        return;
      }
      case 'While': {
        for (;;) {
          this.step();
          const cond = yield* this.evalExpr(stat.cond, scope);
          if (!this.truthy(cond)) break;
          try {
            yield* this.execBlock(stat.body, newScope(scope));
          } catch (e) {
            if (e instanceof BreakSignal) break;
            throw e;
          }
        }
        return;
      }
      case 'Repeat': {
        for (;;) {
          this.step();
          const bodyScope = newScope(scope);
          try {
            yield* this.execBlock(stat.body, bodyScope);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            throw e;
          }
          const cond = yield* this.evalExpr(stat.cond, bodyScope);
          if (this.truthy(cond)) break;
        }
        return;
      }
      case 'NumFor': {
        const start = this.toNumber(yield* this.evalExpr(stat.start, scope));
        const limit = this.toNumber(yield* this.evalExpr(stat.limit, scope));
        const step = stat.step ? this.toNumber(yield* this.evalExpr(stat.step, scope)) : 1;
        if (step === 0) throw new LuaError("'for' step is zero", stat.line);
        for (let v = start; step > 0 ? v <= limit : v >= limit; v += step) {
          this.step();
          const iterScope = newScope(scope);
          iterScope.vars.set(stat.varName, { v });
          try {
            yield* this.execBlock(stat.body, iterScope);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            throw e;
          }
        }
        return;
      }
      case 'GenFor': {
        const values = yield* this.evalExprList(stat.exprs, scope);
        const iter = values[0] ?? null;
        // Lua calls f(state, control) each round; only control updates.
        const control: LuaValue[] = [values[1] ?? null, values[2] ?? null];
        for (;;) {
          this.step();
          const results = yield* this.callValue(iter, control, stat.line);
          if ((results[0] ?? null) === null) break;
          const iterScope = newScope(scope);
          stat.names.forEach((name, i) => {
            iterScope.vars.set(name, { v: results[i] ?? null });
          });
          try {
            yield* this.execBlock(stat.body, iterScope);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            throw e;
          }
          control[1] = results[0];
        }
        return;
      }
      case 'FuncDecl': {
        const fn: LuaFunction = { body: stat.func, closure: scope, name: stat.func.name };
        yield* this.assign(stat.target, fn, scope);
        return;
      }
      case 'LocalFunc': {
        const cell: Cell = { v: null };
        scope.vars.set(stat.name, cell);
        cell.v = { body: stat.func, closure: scope, name: stat.func.name };
        return;
      }
      case 'Return': {
        const values = yield* this.evalExprList(stat.exprs, scope);
        throw new ReturnSignal(values);
      }
      case 'Break': {
        throw new BreakSignal();
      }
      case 'Do': {
        yield* this.execBlock(stat.body, newScope(scope));
        return;
      }
    }
  }

  *assign(target: Expr, value: LuaValue, scope: Scope): Generator<YieldSignal, void, unknown> {
    if (target.kind === 'Var') {
      const cell = lookupCell(scope, target.name);
      if (cell) cell.v = value;
      else this.globals.set(target.name, value);
      return;
    }
    if (target.kind === 'Index') {
      const obj = yield* this.evalExpr(target.obj, scope);
      const key = yield* this.evalExpr(target.key, scope);
      yield* this.setIndexGen(obj, key, value, target.line);
      return;
    }
    throw new LuaError('cannot assign to this expression', target.line);
  }

  // ─── expressions ───

  /** Evaluate an expression list with Lua's last-item expansion. */
  *evalExprList(exprs: Expr[], scope: Scope): Generator<YieldSignal, LuaValue[], unknown> {
    const out: LuaValue[] = [];
    for (let i = 0; i < exprs.length; i++) {
      if (i === exprs.length - 1) out.push(...(yield* this.evalMulti(exprs[i], scope)));
      else out.push(yield* this.evalExpr(exprs[i], scope));
    }
    return out;
  }

  /** Multi-value evaluation (calls + varargs expand; everything else is 1). */
  *evalMulti(expr: Expr, scope: Scope): Generator<YieldSignal, LuaValue[], unknown> {
    if (expr.kind === 'Call' || expr.kind === 'Method') {
      return yield* this.evalCall(expr, scope);
    }
    if (expr.kind === 'Vararg') {
      return this.getVarargs(scope);
    }
    return [yield* this.evalExpr(expr, scope)];
  }

  *evalExpr(expr: Expr, scope: Scope): Generator<YieldSignal, LuaValue, unknown> {
    this.step(expr.line);
    switch (expr.kind) {
      case 'Nil': return null;
      case 'True': return true;
      case 'False': return false;
      case 'Num': {
        const n = Number(expr.value);
        if (Number.isNaN(n)) throw new LuaError(`malformed number '${expr.value}'`, expr.line);
        return n;
      }
      case 'Str': return expr.value;
      case 'Vararg': {
        return this.getVarargs(scope)[0] ?? null;
      }
      case 'Var': {
        const cell = lookupCell(scope, expr.name);
        return cell ? cell.v : this.globals.get(expr.name);
      }
      case 'Paren': {
        return yield* this.evalExpr(expr.inner, scope);
      }
      case 'Index': {
        const obj = yield* this.evalExpr(expr.obj, scope);
        const key = yield* this.evalExpr(expr.key, scope);
        return yield* this.getIndexGen(obj, key, expr.line);
      }
      case 'Call':
      case 'Method': {
        return (yield* this.evalCall(expr, scope))[0] ?? null;
      }
      case 'Func': {
        return { body: expr.func, closure: scope, name: expr.func.name };
      }
      case 'Bin': {
        return yield* this.evalBin(expr, scope);
      }
      case 'Un': {
        const v = yield* this.evalExpr(expr.operand, scope);
        switch (expr.op) {
          case 'not': return !this.truthy(v);
          case '-': return -this.toNumber(v);
          case '#': {
            if (typeof v === 'string') return v.length;
            if (v instanceof LuaTable) return v.length();
            throw new LuaError('attempt to get length of a non-table value', expr.line);
          }
          case '~': return ~this.toNumber(v);
        }
        throw new LuaError(`unknown unary operator ${expr.op}`, expr.line);
      }
      case 'Table': {
        return yield* this.evalTable(expr, scope);
      }
    }
  }

  *evalTable(expr: Expr & { kind: 'Table'; entries: TableEntry[] }, scope: Scope): Generator<YieldSignal, LuaTable, unknown> {
    const table = new LuaTable();
    let arrayIndex = 1;
    for (let i = 0; i < expr.entries.length; i++) {
      const entry = expr.entries[i];
      if (entry.key) {
        const key = yield* this.evalExpr(entry.key, scope);
        const value = yield* this.evalExpr(entry.value, scope);
        table.set(key, value);
      } else if (i === expr.entries.length - 1) {
        // the last positional entry expands: {f()}
        const values = yield* this.evalMulti(entry.value, scope);
        for (const v of values) table.set(arrayIndex++, v);
      } else {
        const value = yield* this.evalExpr(entry.value, scope);
        table.set(arrayIndex++, value);
      }
    }
    return table;
  }

  *evalBin(expr: Expr & { kind: 'Bin' }, scope: Scope): Generator<YieldSignal, LuaValue, unknown> {
    const op = expr.op;
    if (op === 'and') {
      const left = yield* this.evalExpr(expr.left, scope);
      return this.truthy(left) ? yield* this.evalExpr(expr.right, scope) : left;
    }
    if (op === 'or') {
      const left = yield* this.evalExpr(expr.left, scope);
      return this.truthy(left) ? left : yield* this.evalExpr(expr.right, scope);
    }
    const left = yield* this.evalExpr(expr.left, scope);
    const right = yield* this.evalExpr(expr.right, scope);
    switch (op) {
      case '+': return this.toNumber(left) + this.toNumber(right);
      case '-': return this.toNumber(left) - this.toNumber(right);
      case '*': return this.toNumber(left) * this.toNumber(right);
      case '/': return this.toNumber(left) / this.toNumber(right);
      case '//': return Math.floor(this.toNumber(left) / this.toNumber(right));
      case '%': {
        const a = this.toNumber(left), b = this.toNumber(right);
        return a - Math.floor(a / b) * b; // Lua: modulo follows the divisor's sign
      }
      case '^': return Math.pow(this.toNumber(left), this.toNumber(right));
      case '..': return this.concat(left, expr.line) + this.concat(right, expr.line);
      case '==': return this.equals(left, right);
      case '~=': return !this.equals(left, right);
      case '<': case '<=': case '>': case '>=': {
        if (typeof left === 'number' && typeof right === 'number') {
          return op === '<' ? left < right : op === '<=' ? left <= right : op === '>' ? left > right : left >= right;
        }
        if (typeof left === 'string' && typeof right === 'string') {
          return op === '<' ? left < right : op === '<=' ? left <= right : op === '>' ? left > right : left >= right;
        }
        throw new LuaError('attempt to compare two incomparable values', expr.line);
      }
      case '&': return this.toNumber(left) & this.toNumber(right);
      case '|': return this.toNumber(left) | this.toNumber(right);
      case '~': return this.toNumber(left) ^ this.toNumber(right);
      case '<<': return this.toNumber(left) << this.toNumber(right);
      case '>>': return this.toNumber(left) >>> this.toNumber(right);
    }
    throw new LuaError(`unknown operator ${op}`, expr.line);
  }

  *evalCall(expr: Expr & { kind: 'Call' | 'Method' }, scope: Scope): Generator<YieldSignal, LuaValue[], unknown> {
    let fn: LuaValue;
    const args: LuaValue[] = [];
    if (expr.kind === 'Method') {
      const self = yield* this.evalExpr(expr.obj, scope);
      fn = yield* this.getIndexGen(self, expr.name, expr.line);
      args.push(self);
    } else {
      fn = yield* this.evalExpr(expr.fn, scope);
    }
    for (let i = 0; i < expr.args.length; i++) {
      if (i === expr.args.length - 1) args.push(...(yield* this.evalMulti(expr.args[i], scope)));
      else args.push(yield* this.evalExpr(expr.args[i], scope));
    }
    return yield* this.callValue(fn, args, expr.line);
  }

  /** Call any Lua value (functions, or tables with a __call metatable). */
  *callValue(fn: LuaValue, args: LuaValue[], line = 0): Generator<YieldSignal, LuaValue[], unknown> {
    this.step(line);
    if (typeof fn === 'object' && fn !== null && !(fn instanceof LuaTable)) {
      const f = fn as LuaFunction;
      if (f.body) {
        // interpreted function
        const body = f.body;
        const scope = newScope(f.closure ?? null, body.isVararg ? args.slice(body.params.length) : []);
        body.params.forEach((param, i) => {
          scope.vars.set(param, { v: args[i] ?? null });
        });
        try {
          yield* this.execBlock(body.body, scope);
          return [];
        } catch (e) {
          if (e instanceof ReturnSignal) return e.values;
          throw e;
        }
      }
      if (f.native) {
        try {
          const result = f.native(this, args);
          if (result === undefined) return [];
          return Array.isArray(result) ? result : [result];
        } catch (e) {
          throw this.wrapNativeError(e, line);
        }
      }
      if (f.nativeGen) {
        // suspending native — drive its generator, forwarding yields to the host
        let gen: Generator<YieldSignal, LuaValue | LuaValue[] | void, unknown>;
        try {
          gen = f.nativeGen(this, args);
        } catch (e) {
          throw this.wrapNativeError(e, line);
        }
        let resumeIn: unknown = undefined;
        for (;;) {
          let r: IteratorResult<YieldSignal, LuaValue | LuaValue[] | void>;
          try {
            r = gen.next(resumeIn);
          } catch (e) {
            throw this.wrapNativeError(e, line);
          }
          if (r.done) {
            if (r.value === undefined) return [];
            return Array.isArray(r.value) ? r.value : [r.value];
          }
          resumeIn = yield r.value;
        }
      }
    }
    if (fn instanceof LuaTable) {
      const callMeta = fn.metatable ? fn.metatable.get("__call") : null;
      if (callMeta !== null) {
        return yield* this.callValue(callMeta, [fn, ...args], line);
      }
    }
    throw new LuaError(`attempt to call a ${this.typeOf(fn)} value`, line);
  }

  private wrapNativeError(e: unknown, line: number): unknown {
    if (e instanceof LuaError || e instanceof FatalLuaError || e instanceof ReturnSignal) return e;
    return new LuaError(String((e as Error)?.message ?? e), line || this.currentLine);
  }

  /**
   * Drive a call to completion WITHOUT allowing suspends. pcall, sort,
   * gsub and the __index/__newindex paths all suspend properly now, so
   * this is only reached from direct TS callers (e.g. __tostring inside
   * tostring/print) — a welu.wait() there is reported clearly.
   */
  syncCall(fn: LuaValue, args: LuaValue[], line = 0): LuaValue[] {
    const gen = this.callValue(fn, args, line);
    const r = gen.next();
    if (!r.done) {
      throw new LuaError('cannot use welu.wait() inside __tostring or other direct native contexts (move the wait outside)');
    }
    return r.value;
  }

  // ─── indexing with metatables ───
  // The generator versions (used by the interpreter's own paths) let an
  // __index/__newindex FUNCTION suspend — welu.wait inside a metamethod
  // works. The plain sync versions remain for TS-side callers that need
  // a value immediately (they error if the metamethod tries to wait).

  /** __index-aware read that can suspend (interpreter paths). */
  *getIndexGen(obj: LuaValue, key: LuaValue, line = 0): Generator<YieldSignal, LuaValue, unknown> {
    if (obj instanceof LuaTable) {
      const raw = obj.get(key);
      if (raw !== null) return raw;
      const meta = obj.metatable;
      if (meta) {
        const idx = meta.get('__index');
        if (idx !== null) {
          if (idx instanceof LuaTable) return yield* this.getIndexGen(idx, key, line);
          return (yield* this.callValue(idx, [obj, key], line))[0] ?? null;
        }
      }
      return null;
    }
    if (typeof obj === 'string') {
      // string indexing falls through to the string library
      return stringLib.get(key);
    }
    throw new LuaError(`attempt to index a ${this.typeOf(obj)} value`, line);
  }

  /** __newindex-aware write that can suspend (interpreter paths). */
  *setIndexGen(obj: LuaValue, key: LuaValue, value: LuaValue, line = 0): Generator<YieldSignal, void, unknown> {
    if (!(obj instanceof LuaTable)) {
      throw new LuaError(`attempt to index a ${this.typeOf(obj)} value`, line);
    }
    const meta = obj.metatable;
    if (meta) {
      const newIdx = meta.get('__newindex');
      if (newIdx !== null) {
        if (newIdx instanceof LuaTable) {
          yield* this.setIndexGen(newIdx, key, value, line);
          return;
        }
        yield* this.callValue(newIdx, [obj, key, value], line);
        return;
      }
    }
    obj.set(key, value);
  }

  getIndex(obj: LuaValue, key: LuaValue, line = 0): LuaValue {
    if (obj instanceof LuaTable) {
      const raw = obj.get(key);
      if (raw !== null) return raw;
      const meta = obj.metatable;
      if (meta) {
        const idx = meta.get('__index');
        if (idx !== null) {
          if (idx instanceof LuaTable) return this.getIndex(idx, key, line);
          return this.syncCall(idx, [obj, key], line)[0] ?? null;
        }
      }
      return null;
    }
    if (typeof obj === 'string') {
      // string indexing falls through to the string library
      return stringLib.get(key);
    }
    throw new LuaError(`attempt to index a ${this.typeOf(obj)} value`, line);
  }

  setIndex(obj: LuaValue, key: LuaValue, value: LuaValue, line = 0): void {
    if (!(obj instanceof LuaTable)) {
      throw new LuaError(`attempt to index a ${this.typeOf(obj)} value`, line);
    }
    const meta = obj.metatable;
    if (meta) {
      const newIdx = meta.get('__newindex');
      if (newIdx !== null) {
        if (newIdx instanceof LuaTable) {
          this.setIndex(newIdx, key, value, line);
          return;
        }
        this.syncCall(newIdx, [obj, key, value], line);
        return;
      }
    }
    obj.set(key, value);
  }

  // ─── coercion / formatting helpers (used by natives + the runtime) ───

  truthy(v: LuaValue): boolean {
    return v !== null && v !== false;
  }

  typeOf(v: LuaValue): string {
    if (v === null) return 'nil';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'string';
    if (v instanceof LuaTable) return 'table';
    return 'function';
  }

  isCallable(v: LuaValue): boolean {
    if (typeof v === 'object' && v !== null) {
      if (v instanceof LuaTable) return (v.metatable ? v.metatable.get("__call") : null) != null;
      return !!(v as LuaFunction).native || !!(v as LuaFunction).nativeGen || !!(v as LuaFunction).body;
    }
    return false;
  }

  toNumber(v: LuaValue): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (/^-?0[xX][0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed, 16);
      const n = Number(trimmed);
      if (trimmed !== '' && !Number.isNaN(n)) return n;
    }
    throw new LuaError(`attempt to perform arithmetic on a ${this.typeOf(v)} value`, this.currentLine);
  }

  toString(v: LuaValue): string {
    if (v === null) return 'nil';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return this.formatNumber(v);
    if (typeof v === 'string') return v;
    if (v instanceof LuaTable) {
      const ts = v.metatable ? v.metatable.get('__tostring') : null;
      if (ts !== null && this.isCallable(ts)) {
        return this.toString(this.syncCall(ts, [v])[0] ?? null);
      }
      return `table: ${this.idOf(v)}`;
    }
    return `function: ${this.idOf(v)}`;
  }

  formatNumber(n: number): string {
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    if (Number.isNaN(n)) return 'nan';
    if (n === Infinity) return 'inf';
    if (n === -Infinity) return '-inf';
    return String(n);
  }

  concat(v: LuaValue, line = 0): string {
    if (typeof v === 'string' || typeof v === 'number') return this.toString(v);
    throw new LuaError(`attempt to concatenate a ${this.typeOf(v)} value`, line);
  }

  equals(a: LuaValue, b: LuaValue): boolean {
    return a === b;
  }

  private idOf(v: object): string {
    const anyV = v as any;
    if (!anyV.__wbLuaId) {
      anyV.__wbLuaId = `0x${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
    }
    return anyV.__wbLuaId;
  }

  getVarargs(scope: Scope): LuaValue[] {
    for (let s: Scope | null = scope; s; s = s.parent) {
      if (s.varargs !== 'parent') return s.varargs;
    }
    return [];
  }

  /** Start a host-driven call (uniform generator interface for schedulers). */
  startCall(fn: LuaValue, args: LuaValue[], line = 0): Generator<YieldSignal, LuaValue[], unknown> {
    return this.callValue(fn, args, line);
  }

  /** Build a Lua table from a plain JS object (shallow, for natives). */
  static tableFrom(object: Record<string, LuaValue>): LuaTable {
    const t = new LuaTable();
    for (const [k, v] of Object.entries(object)) t.set(k, v);
    return t;
  }

  /** Read a JS value out of a Lua table ({x=,y=,z=} style helpers). */
  static field(t: LuaValue, key: string): LuaValue {
    return t instanceof LuaTable ? t.get(key) : null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Standard library
// ═══════════════════════════════════════════════════════════════════

/** The shared string library (also backs ("str").method indexing). */
export const stringLib = new LuaTable();

function native(fn: (interp: LuaInterpreter, args: LuaValue[]) => LuaValue | LuaValue[] | void): LuaFunction {
  return { native: fn };
}

function arg(args: LuaValue[], i: number): LuaValue {
  return args[i] ?? null;
}
function argNumber(ip: LuaInterpreter, args: LuaValue[], i: number, defaultVal?: number): number {
  const v = args[i];
  if (v === undefined || v === null) return defaultVal ?? 0;
  return ip.toNumber(v);
}
function argString(ip: LuaInterpreter, args: LuaValue[], i: number, defaultVal?: string): string {
  const v = args[i];
  if (v === undefined || v === null) return defaultVal ?? '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return ip.formatNumber(v);
  throw new LuaError(`string expected, got ${ip.typeOf(v)}`, ip.currentLine);
}
function argTable(ip: LuaInterpreter, args: LuaValue[], i: number): LuaTable {
  const v = args[i];
  if (!(v instanceof LuaTable)) throw new LuaError(`table expected, got ${ip.typeOf(v)}`, ip.currentLine);
  return v;
}

/** print() sink — the runtime replaces this to write into the studio console. */
let weluPrintSink: (line: string) => void = (line) => {
  // eslint-disable-next-line no-console
  console.log(`[WeLua] ${line}`);
};
export function setPrintSink(sink: (line: string) => void): void {
  weluPrintSink = sink;
}

function unpackImpl(ip: LuaInterpreter, args: LuaValue[]): LuaValue[] {
  const t = argTable(ip, args, 0);
  const i = args.length > 1 ? ip.toNumber(args[1]) : 1;
  const j = args.length > 2 ? ip.toNumber(args[2]) : t.length();
  const out: LuaValue[] = [];
  for (let k = i; k <= j; k++) out.push(t.get(k));
  return out;
}

function installStdlib(interp: LuaInterpreter): void {
  const G = interp.globals;

  // ── base ──
  G.set('_VERSION', 'Lua 5.4 (WeLua)');
  G.set('_G', G);

  G.set('print', native((ip, args) => {
    weluPrintSink(args.map((a) => ip.toString(a)).join('\t'));
    return [];
  }));

  G.set('type', native((ip, args) => ip.typeOf(arg(args, 0))));
  G.set('tostring', native((ip, args) => ip.toString(arg(args, 0))));
  G.set('tonumber', native((ip, args) => {
    const v = arg(args, 0);
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      const base = args.length > 1 ? argNumber(ip, args, 1, 10) : 10;
      if (base === 10) {
        if (/^-?0[xX][0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed, 16);
        const n = Number(trimmed);
        return trimmed !== '' && !Number.isNaN(n) ? n : null;
      }
      const n = parseInt(trimmed, base);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }));
  G.set('rawget', native((ip, args) => argTable(ip, args, 0).get(arg(args, 1))));
  G.set('rawset', native((ip, args) => {
    argTable(ip, args, 0).set(arg(args, 1), arg(args, 2));
    return args[0];
  }));
  G.set('rawequal', native((ip, args) => ip.equals(arg(args, 0), arg(args, 1))));
  G.set('rawlen', native((ip, args) => {
    const v = arg(args, 0);
    if (typeof v === 'string') return v.length;
    if (v instanceof LuaTable) return v.length();
    throw new LuaError('table or string expected');
  }));
  G.set('setmetatable', native((ip, args) => {
    const t = arg(args, 0);
    if (!(t instanceof LuaTable)) throw new LuaError('bad argument #1 to setmetatable (table expected)');
    const meta = arg(args, 1);
    t.metatable = meta instanceof LuaTable ? meta : null;
    return t;
  }));
  G.set('getmetatable', native((ip, args) => {
    const t = arg(args, 0);
    return t instanceof LuaTable && t.metatable ? t.metatable : null;
  }));
  G.set('assert', native((ip, args) => {
    const v = arg(args, 0);
    if (!ip.truthy(v)) throw new LuaError(args.length > 1 ? ip.toString(args[1]) : 'assertion failed!', ip.currentLine);
    return args;
  }));
  G.set('error', native((ip, args) => {
    const v = arg(args, 0);
    const level = args.length > 1 ? argNumber(ip, args, 1, 1) : 1;
    let value = v;
    if (typeof v === 'string' && level > 0) value = `line ${ip.currentLine}: ${v}`;
    throw new LuaError(value, ip.currentLine);
  }));
  // pcall/xpcall are SUSPENDING natives: a welu.wait() inside the
  // protected function simply suspends the whole thread and resumes
  // through it (the host scheduler drives the yield chain).
  G.set('pcall', { nativeGen: function* (ip: LuaInterpreter, args: LuaValue[]): Generator<YieldSignal, LuaValue | LuaValue[] | void, unknown> {
    const fn = arg(args, 0);
    if (!ip.isCallable(fn)) return [false, 'attempt to call a non-callable value'];
    const gen = ip.startCall(fn, args.slice(1));
    try {
      let resumeIn: unknown = undefined;
      for (;;) {
        const r = gen.next(resumeIn);
        if (r.done) return [true, ...r.value];
        resumeIn = yield r.value; // wait() inside pcall: forward the suspend
      }
    } catch (e) {
      if (e instanceof FatalLuaError) throw e;  // budget kills are final
      if (e instanceof LuaError) return [false, e.value];
      throw e;
    }
  } } as LuaFunction);
  G.set('xpcall', { nativeGen: function* (ip: LuaInterpreter, args: LuaValue[]): Generator<YieldSignal, LuaValue | LuaValue[] | void, unknown> {
    const fn = arg(args, 0);
    const handler = arg(args, 1);
    if (!ip.isCallable(fn)) return [false, 'attempt to call a non-callable value'];
    const gen = ip.startCall(fn, args.slice(2));
    try {
      let resumeIn: unknown = undefined;
      for (;;) {
        const r = gen.next(resumeIn);
        if (r.done) return [true, ...r.value];
        resumeIn = yield r.value;
      }
    } catch (e) {
      if (e instanceof FatalLuaError) throw e;
      if (e instanceof LuaError) {
        const hres = yield* ip.callValue(handler, [e.value]);
        return [false, ...hres];
      }
      throw e;
    }
  } } as LuaFunction);
  G.set('select', native((ip, args) => {
    const n = arg(args, 0);
    if (n === '#') return Math.max(0, args.length - 1);
    const idx = ip.toNumber(n);
    if (idx < 0) return args.slice(args.length + idx);
    return args.slice(idx);
  }));
  G.set('next', native((ip, args) => {
    const t = argTable(ip, args, 0);
    const key = arg(args, 1);
    const keys = t.keys();
    if (key === null) {
      return keys.length > 0 ? [keys[0], t.get(keys[0])] : [null];
    }
    const idx = keys.indexOf(key);
    if (idx === -1) throw new LuaError("invalid key to 'next'");
    if (idx + 1 < keys.length) return [keys[idx + 1], t.get(keys[idx + 1])];
    return [null];
  }));
  G.set('pairs', { nativeGen: function* (ip: LuaInterpreter, args: LuaValue[]): Generator<YieldSignal, LuaValue[] | void, unknown> {
    const t = arg(args, 0);
    if (t instanceof LuaTable) {
      const meta = t.metatable ? t.metatable.get('__pairs') : null;
      if (meta !== null && ip.isCallable(meta)) {
        return yield* ip.callValue(meta, [t]);
      }
    }
    return [G.get('next')!, t, null];
  } } as LuaFunction);
  G.set('ipairs', native((ip, args) => {
    const iter = native((ip2: LuaInterpreter, itArgs: LuaValue[]): LuaValue[] => {
      const t = itArgs[0];
      if (!(t instanceof LuaTable)) return [null];
      const i = ip2.toNumber(itArgs[1] ?? 0) + 1;
      const v = t.get(i);
      if (v === null) return [null];
      return [i, v];
    });
    return [iter, arg(args, 0), 0];
  }));
  G.set('unpack', native(unpackImpl));
  G.set('load', native((ip, args) => {
    // dynamically compile Lua source (same sandbox + budget as everything else)
    const src = arg(args, 0);
    if (typeof src !== 'string') return null;
    try {
      const chunk = parseLua(src);
      return { body: { params: [], isVararg: true, body: chunk.body, line: 0, name: '=(load)' }, closure: null } as LuaFunction;
    } catch {
      return null;
    }
  }));

  // ── math ──
  const math = new LuaTable();
  math.set('pi', Math.PI);
  math.set('huge', Infinity);
  math.set('maxinteger', Number.MAX_SAFE_INTEGER);
  math.set('mininteger', Number.MIN_SAFE_INTEGER);
  math.set('floor', native((ip, args) => Math.floor(argNumber(ip, args, 0))));
  math.set('ceil', native((ip, args) => Math.ceil(argNumber(ip, args, 0))));
  math.set('abs', native((ip, args) => Math.abs(argNumber(ip, args, 0))));
  math.set('sqrt', native((ip, args) => Math.sqrt(argNumber(ip, args, 0))));
  math.set('sin', native((ip, args) => Math.sin(argNumber(ip, args, 0))));
  math.set('cos', native((ip, args) => Math.cos(argNumber(ip, args, 0))));
  math.set('tan', native((ip, args) => Math.tan(argNumber(ip, args, 0))));
  math.set('asin', native((ip, args) => Math.asin(argNumber(ip, args, 0))));
  math.set('acos', native((ip, args) => Math.acos(argNumber(ip, args, 0))));
  math.set('atan', native((ip, args) => {
    if (args.length >= 2) return Math.atan2(argNumber(ip, args, 0), argNumber(ip, args, 1));
    return Math.atan(argNumber(ip, args, 0));
  }));
  math.set('exp', native((ip, args) => Math.exp(argNumber(ip, args, 0))));
  math.set('log', native((ip, args) => {
    if (args.length >= 2) {
      const base = argNumber(ip, args, 1);
      const x = argNumber(ip, args, 0);
      if (base === 2) return Math.log2(x);
      if (base === 10) return Math.log10(x);
      return Math.log(x) / Math.log(base);
    }
    return Math.log(argNumber(ip, args, 0));
  }));
  math.set('pow', native((ip, args) => Math.pow(argNumber(ip, args, 0), argNumber(ip, args, 1))));
  math.set('fmod', native((ip, args) => {
    const a = argNumber(ip, args, 0), b = argNumber(ip, args, 1);
    return a % b;
  }));
  math.set('modf', native((ip, args) => {
    const x = argNumber(ip, args, 0);
    const ipart = x >= 0 ? Math.floor(x) : Math.ceil(x);
    return [ipart, x - ipart];
  }));
  math.set('tointeger', native((ip, args) => {
    const v = arg(args, 0);
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.trim());
      if (!Number.isNaN(n) && Number.isInteger(n)) return n;
    }
    return null;
  }));
  math.set('max', native((ip, args) => {
    if (args.length === 0) throw new LuaError('bad argument #1 to max (value expected)');
    let m = ip.toNumber(args[0]);
    for (let i = 1; i < args.length; i++) m = Math.max(m, ip.toNumber(args[i]));
    return m;
  }));
  math.set('min', native((ip, args) => {
    if (args.length === 0) throw new LuaError('bad argument #1 to min (value expected)');
    let m = ip.toNumber(args[0]);
    for (let i = 1; i < args.length; i++) m = Math.min(m, ip.toNumber(args[i]));
    return m;
  }));
  math.set('random', native((ip, args) => {
    if (args.length === 0) return Math.random();
    const m = argNumber(ip, args, 0);
    if (args.length === 1) {
      if (m < 1) throw new LuaError('interval is empty');
      return Math.floor(Math.random() * m) + 1;
    }
    const n = argNumber(ip, args, 1);
    if (n < m) throw new LuaError('interval is empty');
    return Math.floor(Math.random() * (n - m + 1)) + m;
  }));
  math.set('randomseed', native(() => null));
  math.set('sign', native((ip, args) => Math.sign(argNumber(ip, args, 0))));
  math.set('clamp', native((ip, args) => {
    const x = argNumber(ip, args, 0), lo = argNumber(ip, args, 1), hi = argNumber(ip, args, 2);
    return Math.min(hi, Math.max(lo, x));
  }));
  G.set('math', math);

  // ── string ──
  installStringLib(interp, G);

  // ── table ──
  const table = new LuaTable();
  table.set('insert', native((ip, args) => {
    const t = argTable(ip, args, 0);
    if (args.length >= 3) {
      const pos = Math.trunc(ip.toNumber(args[1]));
      const n = t.length();
      if (pos < 1 || pos > n + 1) throw new LuaError('bad argument #2 to insert (position out of bounds)');
      for (let i = n; i >= pos; i--) t.set(i + 1, t.get(i));
      t.set(pos, args[2]);
    } else {
      t.set(t.length() + 1, arg(args, 1));
    }
    return [];
  }));
  table.set('remove', native((ip, args) => {
    const t = argTable(ip, args, 0);
    const n = t.length();
    if (args.length < 2 || args[1] === null) {
      const v = t.get(n);
      t.set(n, null);
      return v;
    }
    const pos = Math.trunc(ip.toNumber(args[1]));
    if (n === 0 && (pos === 0 || pos === n)) return null;
    if (pos < 1 || pos > n + 1) throw new LuaError('bad argument #1 to remove (position out of bounds)');
    const v = t.get(pos);
    for (let i = pos; i < n; i++) t.set(i, t.get(i + 1));
    t.set(n, null);
    return v;
  }));
  table.set('concat', native((ip, args) => {
    const t = argTable(ip, args, 0);
    const sep = args.length > 1 ? ip.toString(arg(args, 1)) : '';
    const i = args.length > 2 && args[1] !== null ? Math.trunc(ip.toNumber(args[2])) : 1;
    const j = args.length > 3 ? Math.trunc(ip.toNumber(args[3])) : t.length();
    const parts: string[] = [];
    for (let k = i; k <= j; k++) parts.push(ip.concat(t.get(k)));
    return parts.join(sep);
  }));
  table.set('unpack', native(unpackImpl));
  table.set('pack', native((ip, args) => {
    const t = new LuaTable();
    for (let i = 0; i < args.length; i++) t.set(i + 1, args[i]);
    t.set('n', args.length);
    return t;
  }));
  // sort is a SUSPENDING native: a comparator that calls welu.wait()
  // simply pauses the whole thread between comparisons.
  table.set('sort', { nativeGen: function* (ip: LuaInterpreter, args: LuaValue[]): Generator<YieldSignal, LuaValue[] | void, unknown> {
    const t = argTable(ip, args, 0);
    const cmp = args.length > 1 ? args[1] : null;
    const n = t.length();
    const arr: LuaValue[] = [];
    for (let i = 1; i <= n; i++) arr.push(t.get(i));
    const less = function* (a: LuaValue, b: LuaValue): Generator<YieldSignal, boolean, unknown> {
      if (cmp !== null) {
        const r = yield* ip.callValue(cmp, [a, b]);
        return ip.truthy(r[0] ?? null);
      }
      if (typeof a === 'number' && typeof b === 'number') return a < b;
      if (typeof a === 'string' && typeof b === 'string') return a < b;
      throw new LuaError('attempt to compare two incomparable values');
    };
    // merge sort (stable — Lua's table.sort isn't, but stable is friendlier)
    const merged: LuaValue[] = new Array(arr.length);
    const mergeSort = function* (lo: number, hi: number): Generator<YieldSignal, void, unknown> {
      if (hi - lo < 2) return;
      const mid = (lo + hi) >> 1;
      yield* mergeSort(lo, mid);
      yield* mergeSort(mid, hi);
      let a = lo, b = mid, k = lo;
      while (a < mid && b < hi) {
        if (yield* less(arr[b], arr[a])) merged[k++] = arr[b++];
        else merged[k++] = arr[a++];
      }
      while (a < mid) merged[k++] = arr[a++];
      while (b < hi) merged[k++] = arr[b++];
      for (let x = lo; x < hi; x++) arr[x] = merged[x];
    };
    yield* mergeSort(0, arr.length);
    for (let i = 0; i < arr.length; i++) t.set(i + 1, arr[i]);
    return [];
  } } as LuaFunction);
  G.set('table', table);

  // ── os (sandboxed subset) ──
  const os = new LuaTable();
  os.set('time', native(() => Math.floor(Date.now() / 1000)));
  os.set('clock', native(() => performance.now() / 1000));
  os.set('date', native((ip, args) => {
    const format = typeof args[0] === 'string' ? args[0] : '%c';
    const t = typeof args[1] === 'number' ? args[1] * 1000 : Date.now();
    const d = new Date(t);
    const p2 = (x: number) => String(x).padStart(2, '0');
    return format
      .replace(/%Y/g, String(d.getFullYear()))
      .replace(/%m/g, p2(d.getMonth() + 1))
      .replace(/%d/g, p2(d.getDate()))
      .replace(/%H/g, p2(d.getHours()))
      .replace(/%M/g, p2(d.getMinutes()))
      .replace(/%S/g, p2(d.getSeconds()))
      .replace(/%c/g, d.toLocaleString())
      .replace(/%%/g, '%');
  }));
  G.set('os', os);
}

// ═══════════════════════════════════════════════════════════════════
// string library with real Lua patterns (a port of lstrlib's matcher)
// ═══════════════════════════════════════════════════════════════════

const MAX_CAPTURES = 32;
const CAP_OPEN = -2;   // capture still open (between '(' and ')')
const CAP_POS = -1;    // position capture ()

class PatternError extends Error {}

interface Capture { init: number; len: number }

class MatchState {
  level = 0;
  capture: Capture[] = [];
  depth = 0;
  constructor(public src: string, public pat: string) {}
}

/** Does the character class at pat[p] (after '%') match char code c? */
function classMatch(c: number, cl: number): boolean {
  let res: boolean;
  const lower = String.fromCharCode(cl).toLowerCase();
  switch (lower) {
    case 'a': res = (c >= 65 && c <= 90) || (c >= 97 && c <= 122); break;
    case 'c': res = c < 32 || c === 127; break;
    case 'd': res = c >= 48 && c <= 57; break;
    case 'g': res = c > 32 && c < 127; break;
    case 'l': res = c >= 97 && c <= 122; break;
    case 'p': res = (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126); break;
    case 's': res = c === 32 || (c >= 9 && c <= 13); break;
    case 'u': res = c >= 65 && c <= 90; break;
    case 'w': res = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122); break;
    case 'x': res = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70); break;
    default: return cl === c; // literal char after %
  }
  if (cl >= 65 && cl <= 90) return !res; // %A %S ... complements
  return res;
}

/** Index of the ']' closing the bracket class that starts at pat[p]. */
function endBracket(ms: MatchState, p: number): number {
  let i = p + 1;
  if (ms.pat.charCodeAt(i) === 93 /* ] */) return i; // ']' first = literal
  while (i < ms.pat.length) {
    if (ms.pat.charCodeAt(i) === 37 /* % */) { i += 2; continue; }
    if (ms.pat.charCodeAt(i) === 93 /* ] */) return i;
    i++;
  }
  throw new PatternError("malformed pattern (missing ']')");
}

/** Match char c against the [...] class at [pat[p] .. pat[ec]]. */
function matchBracketClass(ms: MatchState, c: number, p: number, ec: number): boolean {
  let i = p + 1;
  let sig = true;
  if (ms.pat.charCodeAt(i) === 94 /* ^ */) { sig = false; i++; }
  while (i < ec) {
    if (ms.pat.charCodeAt(i) === 37 /* % */) {
      i++;
      if (classMatch(c, ms.pat.charCodeAt(i))) return sig;
      i++;
    } else if (i + 2 < ec && ms.pat.charCodeAt(i + 1) === 45 /* - */) {
      if (ms.pat.charCodeAt(i) <= c && c <= ms.pat.charCodeAt(i + 2)) return sig;
      i += 3;
    } else {
      if (ms.pat.charCodeAt(i) === c) return sig;
      i++;
    }
  }
  return !sig;
}

/** One char after the item starting at pat[p] (class/set/literal/escape). */
function classEnd(ms: MatchState, p: number): number {
  const c = ms.pat.charCodeAt(p);
  if (c === 37 /* % */) {
    const next = ms.pat.charCodeAt(p + 1);
    if (p + 1 >= ms.pat.length) throw new PatternError("malformed pattern (ends with '%')");
    if (next === 98 /* b */) return p + 4;
    if (next === 102 /* f */) {
      if (ms.pat.charCodeAt(p + 2) !== 91 /* [ */) throw new PatternError("missing '[' after %f in pattern");
      return endBracket(ms, p + 2) + 1;
    }
    return p + 2;
  }
  if (c === 91 /* [ */) return endBracket(ms, p) + 1;
  if (p >= ms.pat.length) throw new PatternError('malformed pattern');
  return p + 1;
}

/** Does the single-char item at pat[p] consume src[s]? (p..ep-1 = item) */
function singleMatch(ms: MatchState, s: number, p: number): boolean {
  if (s >= ms.src.length) return false;
  const c = ms.src.charCodeAt(s);
  const pc = ms.pat.charCodeAt(p);
  if (pc === 46 /* . */) return true;
  if (pc === 37 /* % */) return classMatch(c, ms.pat.charCodeAt(p + 1));
  if (pc === 91 /* [ */) return matchBracketClass(ms, c, p, endBracket(ms, p));
  return pc === c;
}

/** Greedy repetition (Lua's max_expand). */
function maxExpand(ms: MatchState, s: number, p: number, ep: number): number {
  let count = 0;
  let so = s;
  while (singleMatch(ms, so, p)) { count++; so++; }
  while (count-- >= 0) {
    const r = doMatch(ms, so, ep + 1);
    if (r !== -1) return r;
    so--;
  }
  return -1;
}

/** Lazy repetition (Lua's min_expand). */
function minExpand(ms: MatchState, s: number, p: number, ep: number): number {
  for (;;) {
    const r = doMatch(ms, s, ep + 1);
    if (r !== -1) return r;
    if (!singleMatch(ms, s, p)) return -1;
    s++;
  }
}

function doMatch(ms: MatchState, s: number, p: number): number {
  if (++ms.depth > 200_000) throw new PatternError('pattern too complex');
  while (p < ms.pat.length) {
    const pc = ms.pat.charCodeAt(p);
    switch (pc) {
      case 40 /* ( */: {
        if (ms.pat.charCodeAt(p + 1) === 41 /* ) */) {
          // position capture ()
          if (ms.level >= MAX_CAPTURES) throw new PatternError('too many captures');
          ms.capture[ms.level++] = { init: s, len: CAP_POS };
          const r = doMatch(ms, s, p + 2);
          if (r !== -1) return r;
          ms.level--;
          return -1;
        }
        if (ms.level >= MAX_CAPTURES) throw new PatternError('too many captures');
        ms.capture[ms.level++] = { init: s, len: CAP_OPEN };
        const r = doMatch(ms, s, p + 1);
        if (r !== -1) return r;
        ms.level--;
        return -1;
      }
      case 41 /* ) */: {
        const cap = ms.capture[ms.level - 1];
        if (!cap || cap.len !== CAP_OPEN) throw new PatternError("malformed pattern (unexpected ')')");
        cap.len = s - cap.init; // tentatively close
        const r = doMatch(ms, s, p + 1);
        if (r !== -1) return r;
        cap.len = CAP_OPEN; // reopen on failure
        return -1;
      }
      case 36 /* $ */: {
        if (p + 1 === ms.pat.length) return s === ms.src.length ? s : -1;
        // literal '$'
        if (s < ms.src.length && ms.src.charCodeAt(s) === 36) { s++; p++; continue; }
        return -1;
      }
      case 94 /* ^ */: {
        // a '^' that is not the first pattern char is a literal
        if (s < ms.src.length && ms.src.charCodeAt(s) === 94) { s++; p++; continue; }
        return -1;
      }
      case 37 /* % */: {
        const next = ms.pat.charCodeAt(p + 1);
        if (next === 98 /* b */) {
          // %bxy balanced match
          if (s >= ms.src.length || ms.src.charCodeAt(s) !== ms.pat.charCodeAt(p + 2)) return -1;
          let cont = 1;
          let i = s + 1;
          const open = ms.pat.charCodeAt(p + 2);
          const close = ms.pat.charCodeAt(p + 3);
          let matched = false;
          while (i < ms.src.length) {
            const ch = ms.src.charCodeAt(i);
            if (ch === close && --cont === 0) { s = i + 1; p += 4; matched = true; break; }
            if (ch === open) cont++;
            i++;
          }
          if (matched) continue;
          return -1;
        }
        if (next === 102 /* f */) {
          // %f[set] frontier
          if (ms.pat.charCodeAt(p + 2) !== 91) throw new PatternError("missing '[' after %f in pattern");
          const ec = endBracket(ms, p + 2);
          const prev = s === 0 ? 0 : ms.src.charCodeAt(s - 1);
          const curr = s < ms.src.length ? ms.src.charCodeAt(s) : 0;
          if (!matchBracketClass(ms, prev, p + 2, ec) && matchBracketClass(ms, curr, p + 2, ec)) {
            p = ec + 1;
            continue;
          }
          return -1;
        }
        if (next >= 48 && next <= 57) {
          // %1..%9 backreference
          const cap = ms.capture[next - 49];
          if (!cap || cap.len <= 0) throw new PatternError('invalid capture index');
          const capStr = ms.src.slice(cap.init, cap.init + cap.len);
          if (!ms.src.startsWith(capStr, s)) return -1;
          s += capStr.length;
          p += 2;
          continue;
        }
        // fall through to the generic item path below
        return matchDefault(ms, s, p);
      }
      default:
        return matchDefault(ms, s, p);
    }
  }
  return s;
}

/** The generic item-with-quantifier path (lstrlib's default case). */
function matchDefault(ms: MatchState, s: number, p: number): number {
  const ep = classEnd(ms, p);
  const quant = ep < ms.pat.length ? ms.pat.charCodeAt(ep) : -1;
  if (!singleMatch(ms, s, p)) {
    if (quant === 42 /* * */ || quant === 63 /* ? */ || quant === 45 /* - */) {
      return doMatch(ms, s, ep + 1);
    }
    return -1;
  }
  // the item matched
  switch (quant) {
    case 63 /* ? */: return doMatch(ms, s + 1, ep + 1);
    case 43 /* + */: return maxExpand(ms, s + 1, p, ep);
    case 42 /* * */: return maxExpand(ms, s, p, ep);
    case 45 /* - */: return minExpand(ms, s, p, ep);
    default: return doMatch(ms, s + 1, ep);
  }
}

/** Run one match at s; returns {start, end} or null. */
function runMatch(ms: MatchState, s: number): { start: number; end: number } | null {
  ms.level = 0;
  ms.depth = 0;
  const anchored = ms.pat.charCodeAt(0) === 94;
  const p = anchored ? 1 : 0;
  const end = doMatch(ms, s, p);
  if (end === -1) return null;
  return { start: s, end };
}

/** Search for the first match at or after `from` (respecting the ^ anchor). */
function searchMatch(ms: MatchState, from: number): { start: number; end: number } | null {
  const anchored = ms.pat.charCodeAt(0) === 94;
  let pos = from;
  do {
    const m = runMatch(ms, pos);
    if (m) return m;
    pos++;
  } while (pos <= ms.src.length && !anchored);
  return null;
}

/** Collect captures as Lua values (the whole match first). */
function pushCaptures(ms: MatchState, whole: string): LuaValue[] {
  if (ms.level === 0) return [whole];
  const out: LuaValue[] = [];
  for (let i = 0; i < ms.level; i++) {
    const cap = ms.capture[i];
    if (cap.len === CAP_POS) out.push(cap.init + 1);
    else out.push(ms.src.slice(cap.init, cap.init + cap.len));
  }
  return out;
}

function posRelat(pos: number, len: number): number {
  if (pos >= 0) return pos;
  if (-pos > len) return 0;
  return len + pos + 1;
}

function installStringLib(interp: LuaInterpreter, G: LuaTable): void {
  const S = stringLib;
  G.set('string', S);

  S.set('len', native((ip, args) => argString(ip, args, 0).length));
  S.set('sub', native((ip, args) => {
    const s = argString(ip, args, 0);
    const len = s.length;
    let i = args.length > 1 && args[1] !== null ? posRelat(Math.trunc(ip.toNumber(args[1])), len) : 1;
    let j = args.length > 2 && args[2] !== null ? posRelat(Math.trunc(ip.toNumber(args[2])), len) : len;
    if (i < 1) i = 1;
    if (j > len) j = len;
    if (i > j) return '';
    return s.slice(i - 1, j);
  }));
  S.set('upper', native((ip, args) => argString(ip, args, 0).toUpperCase()));
  S.set('lower', native((ip, args) => argString(ip, args, 0).toLowerCase()));
  S.set('rep', native((ip, args) => {
    const s = argString(ip, args, 0);
    const n = Math.trunc(argNumber(ip, args, 1));
    const sep = args.length > 2 ? argString(ip, args, 2) : '';
    if (n <= 0) return '';
    if (s.length * n > 1_000_000) throw new LuaError('resulting string too large');
    return Array(n).fill(s).join(sep);
  }));
  S.set('reverse', native((ip, args) => argString(ip, args, 0).split('').reverse().join('')));
  S.set('byte', native((ip, args) => {
    const s = argString(ip, args, 0);
    const i = args.length > 1 && args[1] !== null ? posRelat(Math.trunc(ip.toNumber(args[1])), s.length) : 1;
    const j = args.length > 2 && args[2] !== null ? posRelat(Math.trunc(ip.toNumber(args[2])), s.length) : i;
    const out: LuaValue[] = [];
    for (let k = Math.max(1, i); k <= Math.min(s.length, j); k++) out.push(s.charCodeAt(k - 1));
    return out;
  }));
  S.set('char', native((ip, args) => args.map((a) => String.fromCharCode(ip.toNumber(a))).join('')));

  S.set('format', native((ip, args) => {
    const fmt = argString(ip, args, 0);
    let argIdx = 1;
    let out = '';
    let i = 0;
    while (i < fmt.length) {
      const c = fmt[i];
      if (c !== '%') { out += c; i++; continue; }
      i++;
      if (fmt[i] === '%') { out += '%'; i++; continue; }
      let spec = '';
      while ('-+ #0'.includes(fmt[i] ?? '')) { spec += fmt[i]; i++; }
      while (/[0-9]/.test(fmt[i] ?? '')) { spec += fmt[i]; i++; }
      if (fmt[i] === '.') { spec += '.'; i++; while (/[0-9]/.test(fmt[i] ?? '')) { spec += fmt[i]; i++; } }
      const conv = fmt[i];
      if (conv === undefined) throw new LuaError("invalid conversion '%' to 'format'", ip.currentLine);
      i++;
      const getArg = (): LuaValue => (argIdx < args.length ? args[argIdx++] : null);
      const widthMatch = /(\d+)?(?:\.(\d+))?/.exec(spec);
      const applyWidth = (text: string): string => {
        let result = text;
        if (!widthMatch) return result;
        if (widthMatch[2] !== undefined && 'difeE'.includes(conv)) {
          const precision = parseInt(widthMatch[2], 10);
          if (conv === 'd' || conv === 'i') result = String(Math.trunc(Number(result)));
          else result = Number(result).toFixed(precision);
        }
        const width = parseInt(widthMatch[1], 10);
        if (result.length < width) {
          const zeroPad = spec.includes('0') && !spec.includes('-') && 'difeExXo'.includes(conv);
          result = spec.includes('-')
            ? result.padEnd(width)
            : (zeroPad ? '0' : ' ').repeat(width - result.length) + result;
        }
        return result;
      };
      switch (conv) {
        case 'd': case 'i': out += applyWidth(String(Math.trunc(ip.toNumber(getArg() ?? 0)))); break;
        case 'u': out += applyWidth(String(Math.abs(Math.trunc(ip.toNumber(getArg() ?? 0))))); break;
        case 'f': case 'F': out += applyWidth(String(ip.toNumber(getArg() ?? 0))); break;
        case 'e': case 'E': {
          const v = ip.toNumber(getArg() ?? 0).toExponential(6);
          out += applyWidth(conv === 'e' ? v : v.toUpperCase());
          break;
        }
        case 'g': case 'G': {
          const v = ip.toNumber(getArg() ?? 0);
          out += applyWidth(conv === 'g' ? ip.formatNumber(v) : ip.formatNumber(v).toUpperCase());
          break;
        }
        case 'x': out += applyWidth((Math.trunc(ip.toNumber(getArg() ?? 0)) >>> 0).toString(16)); break;
        case 'X': out += applyWidth((Math.trunc(ip.toNumber(getArg() ?? 0)) >>> 0).toString(16).toUpperCase()); break;
        case 'o': out += applyWidth((Math.trunc(ip.toNumber(getArg() ?? 0)) >>> 0).toString(8)); break;
        case 'c': out += String.fromCharCode(ip.toNumber(getArg() ?? 0)); break;
        case 's': out += applyWidth(ip.toString(getArg() ?? null)); break;
        case 'q': {
          const v = ip.toString(getArg() ?? null);
          out += '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0') + '"';
          break;
        }
        default:
          throw new LuaError(`invalid conversion '%${conv}' to 'format'`, ip.currentLine);
      }
    }
    return out;
  }));

  S.set('find', native((ip, args) => {
    const s = argString(ip, args, 0);
    const pat = argString(ip, args, 1);
    const init = args.length > 2 && args[2] !== null
      ? posRelat(Math.trunc(ip.toNumber(args[2])), s.length)
      : 1;
    if (init < 1 || init > s.length + 1) return [null];
    const plain = args.length > 3 && ip.truthy(args[3]);
    if (plain) {
      const idx = s.indexOf(pat, init - 1);
      if (idx === -1) return [null];
      return [idx + 1, idx + pat.length];
    }
    const ms = new MatchState(s, pat);
    const m = searchMatch(ms, init - 1);
    if (!m) return [null];
    if (ms.level === 0) return [m.start + 1, m.end];
    const caps = pushCaptures(ms, s.slice(m.start, m.end));
    return [m.start + 1, m.end, ...caps];
  }));

  S.set('match', native((ip, args) => {
    const s = argString(ip, args, 0);
    const pat = argString(ip, args, 1);
    const init = args.length > 2 && args[2] !== null
      ? posRelat(Math.trunc(ip.toNumber(args[2])), s.length)
      : 1;
    if (init < 1 || init > s.length + 1) return [null];
    const ms = new MatchState(s, pat);
    const m = searchMatch(ms, init - 1);
    if (!m) return [null];
    return pushCaptures(ms, s.slice(m.start, m.end));
  }));

  S.set('gmatch', native((ip, args) => {
    const s = argString(ip, args, 0);
    const pat = argString(ip, args, 1);
    let pos = 0;
    let exhausted = false;
    const iter = native((): LuaValue[] => {
      if (exhausted || pos > s.length) return [null];
      const ms = new MatchState(s, pat);
      const m = searchMatch(ms, pos);
      if (!m) { exhausted = true; return [null]; }
      const caps = pushCaptures(ms, s.slice(m.start, m.end));
      pos = m.end > m.start ? m.end : m.start + 1;
      if (m.end === m.start && m.start >= s.length) exhausted = true;
      return caps;
    });
    return [iter];
  }));

  S.set('gsub', { nativeGen: function* (ip: LuaInterpreter, args: LuaValue[]): Generator<YieldSignal, LuaValue[] | void, unknown> {
    const s = argString(ip, args, 0);
    const pat = argString(ip, args, 1);
    const repl = args[2];
    // Lua's default: srcl + 1 (caps runaway empty matches)
    const maxN = args.length > 3 && args[3] !== null ? Math.trunc(ip.toNumber(args[3])) : s.length + 1;
    let out = '';
    let count = 0;
    let pos = 0;
    // Mirrors lstrlib's str_gsub (verified against real Lua 5.4): the
    // pattern is matched AT pos (never searched); an empty match that
    // starts exactly where the previous non-empty match ENDED is skipped
    // (Lua 5.4's empty-match rule), otherwise one source char is copied.
    let lastMatchEnd = -1;
    while (count < maxN) {
      const ms = new MatchState(s, pat);
      const m = runMatch(ms, pos);
      if (m && m.end > m.start) {
        // non-empty match: add the replacement, skip the span
        count++;
        out += yield* computeGsubReplacement(ip, ms, m, s, repl);
        pos = m.end;
        lastMatchEnd = m.end;
      } else if (m && pos !== lastMatchEnd) {
        // empty match (not right after a non-empty one): add replacement,
        // then copy one source char to guarantee progress
        count++;
        out += yield* computeGsubReplacement(ip, ms, m, s, repl);
        if (pos < s.length) { out += s[pos]; pos++; }
        else break;
      } else {
        // no match at pos, or an empty match to skip
        if (pos < s.length) { out += s[pos]; pos++; }
        else break;
      }
    }
    out += s.slice(Math.min(pos, s.length));
    return [out, count];
  } } as LuaFunction);
}

/** The gsub replacement text for one match (string / table / function).
 *  A generator: function/table replacements go through the interpreter's
 *  call path, so THEY may suspend (welu.wait inside a gsub repl works). */
function* computeGsubReplacement(
  ip: LuaInterpreter,
  ms: MatchState,
  m: { start: number; end: number },
  s: string,
  repl: LuaValue,
): Generator<YieldSignal, string, unknown> {
  const whole = s.slice(m.start, m.end);
  const caps = pushCaptures(ms, whole);
  if (typeof repl === 'string' || typeof repl === 'number') {
    let replacement = ip.toString(repl);
    replacement = replacement.replace(/%[0-9%]/g, (orig) => {
      if (orig === '%%') return '%';
      const idx = parseInt(orig.slice(1), 10);
      if (idx === 0) return whole;
      // caps is 0-indexed (caps[0] = capture 1 in Lua's %1)
      const cap = caps[idx - 1];
      if (cap === undefined || cap === null) throw new LuaError('invalid capture index in replacement string');
      return String(cap);
    });
    return replacement;
  }
  if (repl instanceof LuaTable) {
    // honour __index on the replacement table (it may be a function)
    const v = yield* ip.getIndexGen(repl, caps[0] ?? whole, 0);
    return v === null || v === false ? whole : ip.toString(v);
  }
  if (ip.isCallable(repl)) {
    const r = yield* ip.callValue(repl, caps);
    const v = r[0] ?? null;
    return v === null || v === false ? whole : ip.toString(v);
  }
  throw new LuaError('bad argument #3 to gsub (string/function/table expected)');
}
