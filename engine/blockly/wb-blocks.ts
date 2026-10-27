// ═══════════════════════════════════════════════════════════════════
// WeildBuild — Blockly block definitions for the Code editor (v1.7)
// ═══════════════════════════════════════════════════════════════════
// Real Google Blockly (npm: blockly). Every trigger and action in the
// WeildCode catalog becomes a Blockly block, GENERATED from
// TRIGGER_DEFINITIONS / ACTION_DEFINITIONS so the blocks can never drift
// from what the engine (client + gamehost worker) actually executes.
//
//   • wb_trigger_<type>  hat blocks: trigger params as fields + an
//     "enabled" checkbox. Right click offers "Save as custom rule".
//   • wb_action_<type>   statement blocks: params as fields, nested
//     children (repeat / tell_object) as a DO statement input.
//   • v1.7: NUMBER and TEXT parameters are VALUE INPUTS with shadow
//     literal blocks: type a number/text directly (the shadow), or drag
//     a math / variable / text block into the socket. Variable-NAME
//     parameters render as a variable dropdown field.
//   • wb_var_get / wb_var_set / wb_var_change  variables live HERE now
//     (globals + object variables are created and used with blocks).
//   • wb_math_*  math expression blocks; they compile to the engine's
//     expression strings (variable names resolve at runtime).
//   • wb_advanced_note  placeholder for rules written in the retired
//     advanced text mode (kept untouched; delete the block to remove).
//
// This module registers blocks INTO Blockly when defineWbBlocks() runs
// (called by the client-only CodeEditor component after it dynamically
// imports blockly, so nothing here touches SSR).

import {
  TRIGGER_DEFINITIONS,
  ACTION_DEFINITIONS,
  TriggerParam,
  ActionParam,
} from '../weildcode-types';

// ─── Constants ───

export const TRIGGER_PREFIX = 'wb_trigger_';
export const ACTION_PREFIX = 'wb_action_';

/** Actions that make sense on GAME rules (no part context). */
export const GAME_SAFE_ACTIONS = new Set<string>([
  'print_message', 'play_sound', 'set_variable', 'change_variable',
  'teleport_player', 'modify_player_health', 'set_health', 'kill_player',
  'heal_player', 'send_to_universe', 'wait', 'repeat', 'repeat_every', 'tell_object',
]);

/** Structure-destroying / legacy actions that never appear as blocks. */
export const EXCLUDED_ACTIONS = new Set<string>([
  'remove_from_workspace', // destroys structure (user decision)
  'delete_part',           // destroys structure (user decision)
  'visual_effect',         // legacy, superseded by go_on_fire etc.
]);

/** Field name used for the rule enabled checkbox on trigger blocks. */
export const ENABLED_FIELD = 'p___enabled';

// ─── Text sanitation: the user asked for NO dashes in UI text ───
// Ranges like (0-1) become (0 to 1), spaced dashes become commas,
// em/en dashes become " to ". Word-internal hyphens (de-negate) and
// unary minus (-X) are left alone because they are not dash punctuation.

export function noDash(s: string): string {
  return String(s ?? '')
    .replace(/[—–]/g, ' to ')
    .replace(/(\d)\s*-\s*(\d)/g, '$1 to $2')
    .replace(/ - /g, ', ');
}

/** Escape a literal % for Blockly message interpolation. */
function msgEscape(s: string): string {
  return s.replace(/%/g, '%%');
}

/** Escape text for XML attributes/contents (shadow defaults). */
function xmlEscape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Block type helpers ───

export const triggerBlockType = (type: string) => TRIGGER_PREFIX + type;
export const actionBlockType = (type: string) => ACTION_PREFIX + type;

// ─── Module-level handler for the trigger context menu ───

let customSaveHandler: ((block: unknown) => void) | null = null;
export function setCustomRuleSaveHandler(fn: (block: unknown) => void): void {
  customSaveHandler = fn;
}

// ─── Categories (shared by the toolbox builder + search) ───

export interface WbCategory {
  id: string;
  label: string;
  colour: number;
  types: string[];
}

export function buildCategories(mode: 'object' | 'game'): WbCategory[] {
  const objectTriggers = TRIGGER_DEFINITIONS.filter((t) => !t.gameOnly);
  const gameTriggers = TRIGGER_DEFINITIONS.filter((t) => t.gameOnly);
  const actions = ACTION_DEFINITIONS.filter((a) => !EXCLUDED_ACTIONS.has(a.type));
  const pick = (...types: string[]) =>
    actions.filter((a) => types.includes(a.type) && (mode === 'object' || GAME_SAFE_ACTIONS.has(a.type)))
      .map((a) => actionBlockType(a.type));

  const cats: WbCategory[] = [];
  if (mode === 'object') {
    cats.push({ id: 'events', label: 'Object Events', colour: 45, types: objectTriggers.map((t) => triggerBlockType(t.type)) });
  }
  cats.push({ id: 'game-events', label: 'Game Events', colour: 330, types: gameTriggers.map((t) => triggerBlockType(t.type)) });
  cats.push({ id: 'movement', label: 'Movement', colour: 205, types: pick('move', 'rotate', 'resize') });
  cats.push({ id: 'appearance', label: 'Appearance', colour: 275, types: pick('change_color', 'change_material', 'change_transparency', 'show_name') });
  cats.push({ id: 'physics', label: 'Physics & Forces', colour: 20, types: pick('apply_force', 'explode', 'apply_explosion') });
  cats.push({ id: 'movers', label: 'Body Movers', colour: 185, types: pick('add_body_mover', 'remove_body_mover') });
  cats.push({ id: 'effects', label: 'Effects', colour: 0, types: pick('go_on_fire', 'light_up', 'release_smoke', 'extinguish', 'disable_light', 'clear_smoke') });
  cats.push({ id: 'sound', label: 'Sound', colour: 140, types: pick('play_sound') });
  cats.push({ id: 'player', label: 'Player', colour: 325, types: pick('teleport_player', 'teleport_player_to_part', 'modify_player_health', 'set_health', 'kill_player', 'heal_player', 'send_to_universe') });
  cats.push({ id: 'math', label: 'Math', colour: 230, types: ['wb_math_number', 'wb_math_arithmetic', 'wb_math_single', 'wb_math_minmax', 'wb_math_time', 'wb_math_pi', 'wb_math_raw'] });
  cats.push({ id: 'variables', label: 'Variables', colour: 160, types: ['wb_var_get', 'wb_var_set', 'wb_var_change', 'wb_text'] });
  cats.push({ id: 'control', label: 'Control Flow', colour: 300, types: pick('wait', 'repeat', 'repeat_every', 'tell_object') });
  if (mode === 'object') {
    cats.push({ id: 'parts', label: 'Parts & Model', colour: 55, types: pick('create_part', 'create_copy', 'negate_part', 'de_negate_part', 'separate_part', 'add_rule') });
  }
  cats.push({ id: 'messages', label: 'Messages', colour: 170, types: pick('print_message') });

  return cats.filter((c) => c.types.length > 0);
}

// ─── Search index (label + description per block type) ───

let searchIndex: { type: string; text: string }[] = [];

export function getSearchIndex(): { type: string; text: string }[] {
  return searchIndex;
}

// ─── Param → Blockly arg fragments ───

interface ArgFragment {
  arg: Record<string, unknown>;   // the args0 entry
  message: string;                // message fragment (already escaped)
}

function paramFragments(param: TriggerParam | ActionParam): ArgFragment[] {
  const out: ArgFragment[] = [];
  const label = noDash(param.label ?? param.key);
  switch (param.type) {
    case 'select':
      out.push({
        arg: { type: 'field_dropdown', name: `p_${param.key}`, options: (param.options || []).map((o) => [noDash(o.label), o.value]) },
        message: `${msgEscape(label)} %N`,
      });
      break;
    case 'number':
      // v1.7: value input + shadow number (type a literal, or plug in
      // math / variable blocks).
      out.push({
        arg: { type: 'input_value', name: `p_${param.key}`, check: 'wb_expr' },
        message: `${msgEscape(label)} %N`,
      });
      break;
    case 'boolean':
      out.push({
        arg: { type: 'field_checkbox', name: `p_${param.key}`, checked: !!param.default },
        message: `${msgEscape(label)} %N`,
      });
      break;
    case 'color':
      out.push({
        arg: { type: 'field_colour', name: `p_${param.key}`, colour: String(param.default ?? '#ffffff') },
        message: `${msgEscape(label)} %N`,
      });
      break;
    case 'vector3':
    case 'vector3_relative': {
      // v1.7: each axis is its own value input with a shadow number.
      out.push({ arg: { type: 'input_value', name: `p_${param.key}_x`, check: 'wb_expr' }, message: `${msgEscape(label)} x %N` });
      out.push({ arg: { type: 'input_value', name: `p_${param.key}_y`, check: 'wb_expr' }, message: `y %N` });
      out.push({ arg: { type: 'input_value', name: `p_${param.key}_z`, check: 'wb_expr' }, message: `z %N` });
      break;
    }
    default: // string
      if (param.key === 'variableName') {
        // A variable NAME: dropdown of the workspace variables.
        out.push({
          arg: { type: 'field_variable', name: `p_${param.key}`, variable: String(param.default || 'score') },
          message: `${msgEscape(label)} %N`,
        });
      } else {
        // v1.7: value input + shadow text (type a literal, or plug in
        // text / variable / math blocks).
        out.push({
          arg: { type: 'input_value', name: `p_${param.key}`, check: ['wb_text', 'wb_expr'] },
          message: `${msgEscape(label)} %N`,
        });
      }
      break;
  }
  return out;
}

/** Assemble message0 + args0 from a label and param fragments. */
function assemble(label: string, fragments: ArgFragment[]): { message: string; args: Record<string, unknown>[] } {
  const args: Record<string, unknown>[] = [];
  const parts: string[] = [msgEscape(noDash(label))];
  for (const f of fragments) {
    args.push(f.arg);
    parts.push(f.message.replace('%N', `%${args.length}`));
  }
  return { message: parts.join(' '), args };
}

// ─── Shadow literals for freshly dragged blocks (v1.7) ───

function numShadowXml(n: unknown): string {
  const v = Number(n);
  return `<shadow type="wb_math_number"><field name="NUM">${isFinite(v) ? String(v) : '0'}</field></shadow>`;
}

function textShadowXml(s: unknown): string {
  return `<shadow type="wb_text"><field name="TEXT">${xmlEscape(String(s ?? ''))}</field></shadow>`;
}

/**
 * The <value> XML with shadow literal blocks for every number/text/vector3
 * parameter of a trigger or action block. The toolbox embeds this in its
 * flyout items so a freshly dragged block already shows editable literal
 * pills (which real math/variable/text blocks can replace).
 */
export function blockShadowXml(type: string): string {
  let params: (TriggerParam | ActionParam)[] | null = null;
  if (type.startsWith(TRIGGER_PREFIX)) {
    const t = TRIGGER_DEFINITIONS.find((d) => triggerBlockType(d.type) === type);
    params = t ? t.params : null;
  } else if (type.startsWith(ACTION_PREFIX)) {
    const a = ACTION_DEFINITIONS.find((d) => actionBlockType(d.type) === type);
    params = a ? a.params : null;
  }
  if (!params) return '';
  let xml = '';
  for (const p of params) {
    if (p.type === 'number') {
      xml += `<value name="p_${p.key}">${numShadowXml(p.default ?? 0)}</value>`;
    } else if (p.type === 'string' && p.key !== 'variableName') {
      xml += `<value name="p_${p.key}">${textShadowXml(p.default ?? '')}</value>`;
    } else if (p.type === 'vector3' || p.type === 'vector3_relative') {
      const d = (p.default && typeof p.default === 'object') ? p.default as Record<string, unknown> : {};
      for (const axis of ['x', 'y', 'z'] as const) {
        xml += `<value name="p_${p.key}_${axis}">${numShadowXml(d[axis] ?? 0)}</value>`;
      }
    }
  }
  return xml;
}

// ─── Block registration (idempotent) ───

let blocksDefined = false;

export function defineWbBlocks(Blockly: any): void {
  if (blocksDefined) return;
  blocksDefined = true;

  const jsonDefs: Record<string, unknown>[] = [];

  // 1. Trigger hat blocks
  for (const t of TRIGGER_DEFINITIONS) {
    const frags = (t.params || []).flatMap((p) => paramFragments(p));
    frags.push({ arg: { type: 'field_checkbox', name: ENABLED_FIELD, checked: true }, message: 'on %N' });
    const { message, args } = assemble(t.label, frags);
    jsonDefs.push({
      type: triggerBlockType(t.type),
      message0: message,
      args0: args,
      inputsInline: true,
      nextStatement: null,
      colour: t.gameOnly ? 330 : 45,
      tooltip: noDash(t.description) + ' Uncheck "on" to disable this rule. Right click to save it as a custom rule.',
      helpUrl: '',
    });
  }

  // 2. Action statement blocks
  for (const a of ACTION_DEFINITIONS) {
    if (EXCLUDED_ACTIONS.has(a.type)) continue;
    const frags = (a.params || []).flatMap((p) => paramFragments(p));
    if (a.hasChildren) {
      frags.push({ arg: { type: 'input_statement', name: 'DO' }, message: `${noDash(a.childLabel || 'do')}: %N` });
    }
    const { message, args } = assemble(a.label, frags);
    jsonDefs.push({
      type: actionBlockType(a.type),
      message0: message,
      args0: args,
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      colour: 260,
      tooltip: noDash(a.description) + ' Number and text sockets accept typed values, math blocks, variables and text blocks.',
      helpUrl: '',
    });
  }

  // 3. Advanced-rule placeholder (rules written in text mode stay as-is)
  jsonDefs.push({
    type: 'wb_advanced_note',
    message0: 'Advanced text rule: %1',
    args0: [{ type: 'field_input', name: 'p_name', text: 'Rule', spellcheck: false }],
    colour: 15,
    tooltip: 'This rule was written in the older text mode. It still runs, but it can only be edited here by deleting this block. New rules are built with blocks.',
    helpUrl: '',
  });

  // 4. Variables (globals + object variables are managed with these blocks)
  jsonDefs.push({
    type: 'wb_var_get',
    message0: 'get %1 variable %2',
    args0: [
      { type: 'field_dropdown', name: 'SCOPE', options: [['global', 'global'], ['object (this part)', 'object']] },
      { type: 'field_variable', name: 'VAR', variable: 'score' },
    ],
    output: 'wb_expr',
    colour: 160,
    tooltip: 'Read a variable. Global variables can be read anywhere. Object variables belong to one part.',
    helpUrl: '',
  });
  jsonDefs.push({
    type: 'wb_var_set',
    message0: 'set %1 variable %2 to %3',
    args0: [
      { type: 'field_dropdown', name: 'SCOPE', options: [['global', 'global'], ['object (this part)', 'object']] },
      { type: 'field_variable', name: 'VAR', variable: 'score' },
      { type: 'input_value', name: 'TO' },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 160,
    tooltip: 'Set a variable. The value can be a number, text, another variable, or a math expression. Create variables with the button in the Variables category.',
    helpUrl: '',
  });
  jsonDefs.push({
    type: 'wb_var_change',
    message0: 'change %1 variable %2 by %3, mode %4',
    args0: [
      { type: 'field_dropdown', name: 'SCOPE', options: [['global', 'global'], ['object (this part)', 'object']] },
      { type: 'field_variable', name: 'VAR', variable: 'score' },
      { type: 'input_value', name: 'BY', check: 'wb_expr' },
      { type: 'field_dropdown', name: 'MODE', options: [['set to result', 'set'], ['add result', 'add'], ['multiply by result', 'multiply']] },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 160,
    tooltip: 'Change a variable with math. Inside the expression, the block "get variable" for this same variable means its current value.',
    helpUrl: '',
  });

  // 5. Math expression blocks (compile to engine expression strings)
  jsonDefs.push({
    type: 'wb_math_number',
    message0: 'number %1',
    args0: [{ type: 'field_number', name: 'NUM', value: 1 }],
    output: 'wb_expr',
    colour: 230,
    tooltip: 'A number.',
    helpUrl: '',
  });
  jsonDefs.push({
    type: 'wb_math_arithmetic',
    message0: '%1 %2 %3',
    args0: [
      { type: 'field_dropdown', name: 'OP', options: [['+', '+'], ['-', '-'], ['×', '*'], ['÷', '/'], ['^', '^']] },
      { type: 'input_value', name: 'A', check: 'wb_expr' },
      { type: 'input_value', name: 'B', check: 'wb_expr' },
    ],
    inputsInline: true,
    output: 'wb_expr',
    colour: 230,
    tooltip: 'Arithmetic. ^ is power.',
    helpUrl: '',
  });
  jsonDefs.push({
    type: 'wb_math_single',
    message0: '%1 of %2',
    args0: [
      {
        type: 'field_dropdown', name: 'FN', options: [
          ['square root', 'sqrt'], ['absolute', 'abs'], ['round', 'round'], ['round down', 'floor'], ['round up', 'ceil'],
          ['negate', 'negate'], ['sine', 'sin'], ['cosine', 'cos'], ['tangent', 'tan'],
        ],
      },
      { type: 'input_value', name: 'A', check: 'wb_expr' },
    ],
    inputsInline: true,
    output: 'wb_expr',
    colour: 230,
    tooltip: 'Single value math.',
    helpUrl: '',
  });
  jsonDefs.push({
    type: 'wb_math_minmax',
    message0: '%1 of %2 and %3',
    args0: [
      { type: 'field_dropdown', name: 'FN', options: [['smallest', 'min'], ['largest', 'max']] },
      { type: 'input_value', name: 'A', check: 'wb_expr' },
      { type: 'input_value', name: 'B', check: 'wb_expr' },
    ],
    inputsInline: true,
    output: 'wb_expr',
    colour: 230,
    tooltip: 'Smaller or larger of two values.',
    helpUrl: '',
  });
  jsonDefs.push({
    type: 'wb_math_time',
    message0: 'world time',
    output: 'wb_expr',
    colour: 230,
    tooltip: 'The current world clock time.',
    helpUrl: '',
  });
  jsonDefs.push({
    type: 'wb_math_pi',
    message0: 'π',
    output: 'wb_expr',
    colour: 230,
    tooltip: 'The number pi.',
    helpUrl: '',
  });
  jsonDefs.push({
    type: 'wb_math_raw',
    message0: 'expression: %1',
    args0: [{ type: 'field_input', name: 'EXPR', text: 'variable + 1', spellcheck: false }],
    output: 'wb_expr',
    colour: 230,
    tooltip: 'A raw math expression (advanced). "variable" means the current value of the variable being changed. Variable names and sqrt, abs, floor, round, min, max, pow, sin, cos, tan, PI, timeOfDay all work.',
    helpUrl: '',
  });
  jsonDefs.push({
    type: 'wb_text',
    message0: 'text %1',
    args0: [{ type: 'field_input', name: 'TEXT', text: 'hello', spellcheck: false }],
    output: 'wb_text',
    colour: 160,
    tooltip: 'A piece of text. Use it for text values (names, messages).',
    helpUrl: '',
  });

  Blockly.defineBlocksWithJsonArray(jsonDefs);

  // Right click any trigger block → save its whole stack as a custom rule.
  for (const t of TRIGGER_DEFINITIONS) {
    const def = Blockly.Blocks[triggerBlockType(t.type)];
    if (def) {
      def.customContextMenu = function (options: unknown[]) {
        (options as { text: string; enabled: boolean; callback: () => void }[]).push({
          text: 'Save as custom rule...',
          enabled: true,
          callback: () => customSaveHandler?.(this),
        });
      };
    }
  }

  // Build the search index.
  searchIndex = [];
  for (const t of TRIGGER_DEFINITIONS) {
    searchIndex.push({ type: triggerBlockType(t.type), text: `${t.label} ${t.description} ${t.type}`.toLowerCase() });
  }
  for (const a of ACTION_DEFINITIONS) {
    if (EXCLUDED_ACTIONS.has(a.type)) continue;
    searchIndex.push({ type: actionBlockType(a.type), text: `${a.label} ${a.description} ${a.type}`.toLowerCase() });
  }
  for (const [type, text] of [
    ['wb_var_get', 'get read variable value global object'],
    ['wb_var_set', 'set write variable value global object'],
    ['wb_var_change', 'change add multiply increment variable math'],
    ['wb_math_number', 'number value'],
    ['wb_math_arithmetic', 'plus minus add subtract multiply divide times power arithmetic math'],
    ['wb_math_single', 'sqrt square root abs absolute round floor ceil negate sin cos tan math'],
    ['wb_math_minmax', 'min max smallest largest math'],
    ['wb_math_time', 'world time clock'],
    ['wb_math_pi', 'pi constant math'],
    ['wb_math_raw', 'raw expression advanced math formula'],
    ['wb_text', 'text string message'],
  ] as [string, string][]) {
    searchIndex.push({ type, text: text.toLowerCase() });
  }
}
