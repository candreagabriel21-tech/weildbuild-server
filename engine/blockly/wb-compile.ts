// ═══════════════════════════════════════════════════════════════════
// WeildBuild — Blockly ⇄ WeildCode compiler (v1.6)
// ═══════════════════════════════════════════════════════════════════
// The Code editor is a VIEW over the same WeildCodeRule model the whole
// platform runs (Logic panel, weildcode-engine, the gamehost workers,
// .wbworld files). This module converts in both directions:
//
//   compileWorkspace()   Blockly workspace → WeildCodeRule[]
//   decompileRulesToXml() WeildCodeRule[] → Blockly XML (load into a workspace)
//   ruleToBlockXml()      one rule → Blockly XML (custom-rule flyout items)
//
// Everything is duck-typed against Blockly's block API (getBlockType,
// getFieldValue, getNextBlock, getInputTargetBlock) so the module stays
// importable without a DOM.

import {
  TRIGGER_DEFINITIONS,
  ACTION_DEFINITIONS,
  WeildCodeRule,
  WeildCodeAction,
} from '../weildcode-types';
import {
  TRIGGER_PREFIX,
  ACTION_PREFIX,
  ENABLED_FIELD,
  triggerBlockType,
  actionBlockType,
} from './wb-blocks';

// ─── Small helpers ───

export function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function xmlEscape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function numField(block: any, name: string, fallback: number): number {
  const v = Number(block.getFieldValue(name));
  return isFinite(v) ? v : fallback;
}

function boolField(block: any, name: string): boolean {
  const v = block.getFieldValue(name);
  return v === true || v === 'TRUE' || v === 'true';
}

// ─── Math expression compile (blocks → engine expression string) ───

interface ExprCtx {
  /** Variable being changed: var_get of THIS name means "variable". */
  selfVar?: string;
}

function compileExprBlock(block: any, ctx: ExprCtx, warnings: string[]): string {
  if (!block) return '0';
  switch (block.type) {
    case 'wb_math_number': {
      const v = Number(block.getFieldValue('NUM'));
      return isFinite(v) ? String(v) : '0';
    }
    case 'wb_var_get': {
      const name = String(block.getFieldValue('VAR') ?? 'variable');
      // Inside change_variable, reading the variable itself means "variable".
      return ctx.selfVar && name === ctx.selfVar ? 'variable' : name;
    }
    case 'wb_math_time':
      return 'timeOfDay';
    case 'wb_math_pi':
      return 'PI';
    case 'wb_math_raw':
      return String(block.getFieldValue('EXPR') ?? '0').trim() || '0';
    case 'wb_math_arithmetic': {
      const op = String(block.getFieldValue('OP'));
      const a = compileExprBlock(block.getInputTargetBlock('A'), ctx, warnings);
      const b = compileExprBlock(block.getInputTargetBlock('B'), ctx, warnings);
      if (op === '^') return `pow(${a}, ${b})`;
      // Parenthesize only non-trivial operands (keeps "variable + 1"
      // round-tripping EXACTLY, nested math stays precedence-safe).
      const simple = (s: string) => /^-?[\w.]+$/.test(s);
      const A = simple(a) ? a : `(${a})`;
      const B = simple(b) ? b : `(${b})`;
      return `${A} ${op} ${B}`;
    }
    case 'wb_math_single': {
      const fn = String(block.getFieldValue('FN'));
      const a = compileExprBlock(block.getInputTargetBlock('A'), ctx, warnings);
      if (fn === 'negate') return `(-(${a}))`;
      return `${fn}(${a})`;
    }
    case 'wb_math_minmax': {
      const fn = block.getFieldValue('FN') === 'max' ? 'max' : 'min';
      const a = compileExprBlock(block.getInputTargetBlock('A'), ctx, warnings);
      const b = compileExprBlock(block.getInputTargetBlock('B'), ctx, warnings);
      return `${fn}(${a}, ${b})`;
    }
    case 'wb_text':
      warnings.push('A text block inside a math expression counts as 0.');
      return '0';
    default:
      return '0';
  }
}

/** Compile the "to" value of set variable: math, variable reference, or text. */
function compileValueBlock(block: any, warnings: string[]): string | number {
  if (!block) return 0;
  const s = block.type === 'wb_text'
    ? String(block.getFieldValue('TEXT') ?? '')
    : compileExprBlock(block, {}, warnings);
  // Canonical form: numeric values are stored as numbers (the engine
  // accepts both, but this keeps round trips clean).
  const n = Number(s);
  return s.trim() !== '' && !isNaN(n) ? n : s;
}

// ─── Workspace → rules ───

export interface CompiledWorkspace {
  rules: WeildCodeRule[];
  /** Ids of advanced text rules represented by placeholder blocks. */
  preservedRuleIds: string[];
  warnings: string[];
}

function compileActionBlock(block: any, warnings: string[]): WeildCodeAction | null {
  // Variable blocks synthesize the underlying actions.
  if (block.type === 'wb_var_set') {
    return {
      id: (block as any).wbActionId || newId('act'),
      type: 'set_variable',
      params: {
        variableName: String(block.getFieldValue('VAR') ?? ''),
        value: compileValueBlock(block.getInputTargetBlock('TO'), warnings),
        scope: String(block.getFieldValue('SCOPE') || 'global'),
      },
      enabled: true,
    };
  }
  if (block.type === 'wb_var_change') {
    const varName = String(block.getFieldValue('VAR') ?? '');
    return {
      id: (block as any).wbActionId || newId('act'),
      type: 'change_variable',
      params: {
        variableName: varName,
        expression: compileExprBlock(block.getInputTargetBlock('BY'), { selfVar: varName }, warnings) || 'variable + 1',
        mode: String(block.getFieldValue('MODE') || 'add'),
        scope: String(block.getFieldValue('SCOPE') || 'global'),
      },
      enabled: true,
    };
  }

  if (!block.type.startsWith(ACTION_PREFIX)) return null;
  const actionType = block.type.slice(ACTION_PREFIX.length);
  const def = ACTION_DEFINITIONS.find((d) => d.type === actionType);
  if (!def) {
    warnings.push(`Unknown action block "${actionType}" was skipped.`);
    return null;
  }

  const params: Record<string, any> = {};
  for (const p of def.params) {
    if (p.type === 'vector3' || p.type === 'vector3_relative') {
      const base = (p.default && typeof p.default === 'object') ? { ...p.default } : {};
      params[p.key] = {
        ...base,
        x: numField(block, `p_${p.key}_x`, Number(base.x ?? 0)),
        y: numField(block, `p_${p.key}_y`, Number(base.y ?? 0)),
        z: numField(block, `p_${p.key}_z`, Number(base.z ?? 0)),
      };
    } else if (p.type === 'number') {
      params[p.key] = numField(block, `p_${p.key}`, Number(p.default ?? 0));
    } else if (p.type === 'boolean') {
      params[p.key] = boolField(block, `p_${p.key}`);
    } else {
      params[p.key] = String(block.getFieldValue(`p_${p.key}`) ?? p.default ?? '');
    }
  }

  const action: WeildCodeAction = {
    id: (block as any).wbActionId || newId('act'),
    type: def.type,
    params,
    enabled: true,
  };
  if (def.hasChildren) {
    action.children = compileChain(block.getInputTargetBlock('DO'), warnings);
  }
  return action;
}

function compileChain(startBlock: any, warnings: string[]): WeildCodeAction[] {
  const actions: WeildCodeAction[] = [];
  let b = startBlock;
  while (b) {
    const next = b.getNextBlock();
    const action = compileActionBlock(b, warnings);
    if (action) actions.push(action);
    b = next;
  }
  return actions;
}

function triggerParamsFromBlock(block: any, def: { params: typeof ACTION_DEFINITIONS[number]['params'] }): Record<string, any> {
  const params: Record<string, any> = {};
  for (const p of def.params as any[]) {
    if (p.type === 'vector3' || p.type === 'vector3_relative') {
      params[p.key] = {
        x: numField(block, `p_${p.key}_x`, 0),
        y: numField(block, `p_${p.key}_y`, 0),
        z: numField(block, `p_${p.key}_z`, 0),
      };
    } else if (p.type === 'number') {
      params[p.key] = numField(block, `p_${p.key}`, Number(p.default ?? 0));
    } else if (p.type === 'boolean') {
      params[p.key] = boolField(block, `p_${p.key}`);
    } else {
      params[p.key] = String(block.getFieldValue(`p_${p.key}`) ?? p.default ?? '');
    }
  }
  return params;
}

export function compileWorkspace(workspace: any): CompiledWorkspace {
  const rules: WeildCodeRule[] = [];
  const preservedRuleIds: string[] = [];
  const warnings: string[] = [];

  const tops: any[] = workspace.getTopBlocks(true); // ordered by position
  for (const block of tops) {
    const type: string = block.type || '';
    if (type.startsWith(TRIGGER_PREFIX)) {
      const trigType = type.slice(TRIGGER_PREFIX.length);
      const def = TRIGGER_DEFINITIONS.find((t) => t.type === trigType);
      if (!def) {
        warnings.push(`Unknown trigger block "${trigType}" was skipped.`);
        continue;
      }
      rules.push({
        id: (block as any).wbRuleId || newId('rule'),
        name: def.label,
        trigger: { type: def.type, params: triggerParamsFromBlock(block, def as any) },
        actions: compileChain(block.getNextBlock(), warnings),
        mode: 'simple',
        enabled: boolField(block, ENABLED_FIELD),
      });
    } else if (type === 'wb_advanced_note') {
      if ((block as any).wbRuleId) preservedRuleIds.push((block as any).wbRuleId);
    } else if (type === 'wb_var_set' || type === 'wb_var_change') {
      warnings.push('A variable block at the top level needs a trigger block above it. It was skipped.');
    } else {
      warnings.push('A block was not attached under a trigger block and was skipped.');
    }
  }

  return { rules, preservedRuleIds, warnings };
}

/** Compile ONE trigger stack (used by "Save as custom rule"). */
export function compileRuleFromTriggerBlock(block: any): WeildCodeRule | null {
  const type: string = block?.type || '';
  if (!type.startsWith(TRIGGER_PREFIX)) return null;
  const trigType = type.slice(TRIGGER_PREFIX.length);
  const def = TRIGGER_DEFINITIONS.find((t) => t.type === trigType);
  if (!def) return null;
  return {
    id: newId('rule'),
    name: def.label,
    trigger: { type: def.type, params: triggerParamsFromBlock(block, def as any) },
    actions: compileChain(block.getNextBlock(), []),
    mode: 'simple',
    enabled: boolField(block, ENABLED_FIELD),
  };
}

/** True when a block type represents an action in a rule stack. */
function isActionish(type: string): boolean {
  return type.startsWith(ACTION_PREFIX) || type === 'wb_var_set' || type === 'wb_var_change';
}

/**
 * Tag freshly-loaded blocks with their action ids so a later compile
 * reproduces the SAME ids (clean diffs, no spurious updates/undo entries).
 */
export function tagActionIds(startBlock: any, actions: WeildCodeAction[]): void {
  let b = startBlock;
  let i = 0;
  while (b && i < actions.length) {
    const next = b.getNextBlock();
    const a = actions[i];
    if (isActionish(b.type)) {
      (b as any).wbActionId = a.id;
      i++;
      const kids = b.getInputTargetBlock('DO');
      if (kids && a.children && a.children.length > 0) tagActionIds(kids, a.children);
    }
    b = next;
  }
}

// ─── Rules → Blockly XML ───

function fieldXml(name: string, value: string): string {
  return `<field name="${name}">${xmlEscape(value)}</field>`;
}

/** Decompile a stored value into a value-input block (number, raw math, or text). */
function valueToXml(value: unknown): string {
  const s = String(value ?? '').trim();
  if (s !== '' && !isNaN(Number(s))) {
    return `<block type="wb_math_number">${fieldXml('NUM', s)}</block>`;
  }
  if (/[+\-*/^()]|\bsqrt\b|\babs\b|\bfloor\b|\bceil\b|\bround\b|\bsin\b|\bcos\b|\btan\b|\bmin\b|\bmax\b|\bpow\b|\bPI\b|\btimeOfDay\b|\bvariable\b/.test(s)) {
    return `<block type="wb_math_raw">${fieldXml('EXPR', s)}</block>`;
  }
  return `<block type="wb_text">${fieldXml('TEXT', String(value ?? ''))}</block>`;
}

/** Decompile a change_variable expression into a BY input block. */
function expressionToXml(expr: string, varName: string, scope: string): string {
  const s = String(expr ?? '').trim().replace(/^\((.*)\)$/, '$1');
  // Common shape: "variable + 1" → arithmetic(get this variable, +, 1)
  const m = s.match(/^variable\s*([+\-*/^])\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const op = m[1];
    const self = `<block type="wb_var_get">${fieldXml('SCOPE', scope)}${fieldXml('VAR', varName)}</block>`;
    const num = `<block type="wb_math_number">${fieldXml('NUM', m[2])}</block>`;
    return `<block type="wb_math_arithmetic">${fieldXml('OP', op)}<value name="A">${self}</value><value name="B">${num}</value></block>`;
  }
  return `<block type="wb_math_raw">${fieldXml('EXPR', String(expr ?? 'variable + 1'))}</block>`;
}

function knownAction(action: WeildCodeAction): boolean {
  if (action.type === 'set_variable' || action.type === 'change_variable') return true;
  return !!ACTION_DEFINITIONS.find((d) => d.type === action.type);
}

/** Build ONE action block; nextXml (already built) nests as <next> inside it. */
function actionToXml(action: WeildCodeAction, nextXml: string): string {
  if (action.type === 'set_variable') {
    const scope = String(action.params.scope || 'global');
    return `<block type="wb_var_set">` +
      fieldXml('SCOPE', scope) +
      fieldXml('VAR', String(action.params.variableName ?? '')) +
      `<value name="TO">${valueToXml(action.params.value)}</value>` +
      nextXml +
      `</block>`;
  }
  if (action.type === 'change_variable') {
    const scope = String(action.params.scope || 'global');
    const varName = String(action.params.variableName ?? '');
    return `<block type="wb_var_change">` +
      fieldXml('SCOPE', scope) +
      fieldXml('VAR', varName) +
      `<value name="BY">${expressionToXml(String(action.params.expression ?? 'variable + 1'), varName, scope)}</value>` +
      fieldXml('MODE', String(action.params.mode || 'set')) +
      nextXml +
      `</block>`;
  }

  const def = ACTION_DEFINITIONS.find((d) => d.type === action.type);
  if (!def) return ''; // unknown action: skipped (catalog is stable)

  let xml = `<block type="${actionBlockType(def.type)}">`;
  for (const p of def.params) {
    const v = action.params?.[p.key];
    if (p.type === 'vector3' || p.type === 'vector3_relative') {
      const o = (v && typeof v === 'object') ? v : {};
      xml += fieldXml(`p_${p.key}_x`, String(o.x ?? 0));
      xml += fieldXml(`p_${p.key}_y`, String(o.y ?? 0));
      xml += fieldXml(`p_${p.key}_z`, String(o.z ?? 0));
    } else if (p.type === 'boolean') {
      xml += fieldXml(`p_${p.key}`, v ? 'TRUE' : 'FALSE');
    } else if (p.type === 'number') {
      xml += fieldXml(`p_${p.key}`, String(Number(v ?? p.default ?? 0)));
    } else {
      xml += fieldXml(`p_${p.key}`, String(v ?? p.default ?? ''));
    }
  }
  if (def.hasChildren) {
    const kids = (action.children || []).filter(knownAction);
    if (kids.length > 0) xml += `<statement name="DO">${chainToXml(kids)}</statement>`;
  }
  xml += nextXml;
  xml += '</block>';
  return xml;
}

/** A rule's action list → the first block, with the rest nested as <next>. */
function chainToXml(actions: WeildCodeAction[]): string {
  const usable = actions.filter(knownAction);
  if (usable.length === 0) return '';
  const [first, ...rest] = usable;
  const nextXml = rest.length > 0 ? `<next>${chainToXml(rest)}</next>` : '';
  return actionToXml(first, nextXml);
}

/** One rule → a top-level block stack (no x/y). Used by custom-rule flyouts. */
export function ruleToBlockXml(rule: WeildCodeRule): string {
  if (rule.mode === 'advanced') {
    return `<block type="wb_advanced_note">${fieldXml('p_name', rule.name || 'Rule')}</block>`;
  }
  const def = TRIGGER_DEFINITIONS.find((t) => t.type === rule.trigger.type);
  if (!def) {
    return `<block type="wb_advanced_note">${fieldXml('p_name', rule.name || 'Rule')}</block>`;
  }
  let xml = `<block type="${triggerBlockType(def.type)}">`;
  xml += fieldXml(ENABLED_FIELD, rule.enabled ? 'TRUE' : 'FALSE');
  for (const p of def.params) {
    const v = rule.trigger.params?.[p.key];
    if (p.type === 'vector3') {
      const o = (v && typeof v === 'object') ? v : {};
      xml += fieldXml(`p_${p.key}_x`, String(o.x ?? 0));
      xml += fieldXml(`p_${p.key}_y`, String(o.y ?? 0));
      xml += fieldXml(`p_${p.key}_z`, String(o.z ?? 0));
    } else if (p.type === 'number') {
      xml += fieldXml(`p_${p.key}`, String(Number(v ?? p.default ?? 0)));
    } else {
      xml += fieldXml(`p_${p.key}`, String(v ?? p.default ?? ''));
    }
  }
  xml += '\n';
  const actionChain = chainToXml(rule.actions || []);
  if (actionChain) xml += `<next>${actionChain}</next>`;
  xml += '</block>';
  return xml;
}

/**
 * All rules → a full <xml> document for Blockly.Xml.domToWorkspace.
 * Returns the rule id per emitted top block (same order) so the caller can
 * tag blocks with their rule ids for stable round-trips.
 */
export function decompileRulesToXml(rules: WeildCodeRule[]): { xml: string; ruleIds: string[] } {
  const parts: string[] = [];
  const ruleIds: string[] = [];
  let y = 16;
  for (const rule of rules) {
    const stack = ruleToBlockXml(rule);
    parts.push(stack.replace('<block ', `<block x="16" y="${y}" `));
    ruleIds.push(rule.id);
    // rough vertical spacing so stacks do not overlap (approximate is fine)
    y += 90 + 55 * (1 + (rule.actions?.length || 0));
  }
  return {
    xml: `<xml xmlns="https://developers.google.com/blockly/xml">${parts.join('\n')}</xml>`,
    ruleIds,
  };
}
