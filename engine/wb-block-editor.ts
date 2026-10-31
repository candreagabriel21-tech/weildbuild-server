// ═══════════════════════════════════════════════════════════════════
// WeildBuild, Block editor catalog (v7, our own editor - no Blockly)
// ═══════════════════════════════════════════════════════════════════
// The new Code editor is built in-house: a React block palette + stack
// that edits WeildCodeRule JSON DIRECTLY (the same model the engine runs
// and projects save). This module is the catalog: which category every
// trigger/action belongs to, the category colors, and small factories.
//
// The catalog is the single source of truth for the palette - and the
// test suite walks TRIGGER_DEFINITIONS / ACTION_DEFINITIONS to assert
// EVERY command has a home (nothing can be "skipped" by accident again).

import {
  TriggerType,
  ActionType,
  TRIGGER_DEFINITIONS,
  ACTION_DEFINITIONS,
  WeildCodeRule,
  WeildCodeAction,
  createBlankAction,
  createBlankOperand,
  OperandSpec,
} from './weildcode-types';

// ─── Categories ───

export interface BlockCategory {
  id: string;
  label: string;
  /** Tailwind classes: the block's left border + icon/text tint. */
  border: string;
  text: string;
  chip: string;
}

export const CATEGORIES: Record<string, BlockCategory> = {
  events:    { id: 'events',    label: 'Events',       border: 'border-amber-400/70',   text: 'text-amber-300',    chip: 'bg-amber-500/15' },
  control:   { id: 'control',   label: 'Control',      border: 'border-orange-400/70',  text: 'text-orange-300',   chip: 'bg-orange-500/15' },
  motion:    { id: 'motion',    label: 'Motion',       border: 'border-sky-400/70',     text: 'text-sky-300',      chip: 'bg-sky-500/15' },
  looks:     { id: 'looks',     label: 'Looks',        border: 'border-violet-400/70',  text: 'text-violet-300',   chip: 'bg-violet-500/15' },
  physics:   { id: 'physics',   label: 'Properties',   border: 'border-teal-400/70',    text: 'text-teal-300',     chip: 'bg-teal-500/15' },
  players:   { id: 'players',   label: 'Players',      border: 'border-emerald-400/70', text: 'text-emerald-300',  chip: 'bg-emerald-500/15' },
  variables: { id: 'variables', label: 'Variables',    border: 'border-pink-400/70',    text: 'text-pink-300',     chip: 'bg-pink-500/15' },
  custom:    { id: 'custom',    label: 'Custom rules', border: 'border-lime-400/70',    text: 'text-lime-300',     chip: 'bg-lime-500/15' },
};

// ─── Where every ACTION lives in the palette ───
// (if_condition lives in "control" - it IS control flow.)
export const ACTION_CATEGORY: Record<ActionType, string> = {
  if_condition: 'control',
  repeat: 'control',
  repeat_every: 'control',
  wait: 'control',
  tell_object: 'control',

  move: 'motion',
  rotate: 'motion',
  resize: 'motion',
  apply_force: 'motion',
  create_part: 'motion',
  create_copy: 'motion',
  delete_part: 'motion',
  remove_from_workspace: 'motion',
  separate_part: 'motion',
  teleport_player: 'motion',
  teleport_player_to_part: 'motion',
  send_to_universe: 'motion',

  change_color: 'looks',
  change_material: 'looks',
  change_transparency: 'looks',
  go_on_fire: 'looks',
  light_up: 'looks',
  release_smoke: 'looks',
  extinguish: 'looks',
  disable_light: 'looks',
  clear_smoke: 'looks',
  visual_effect: 'looks',
  apply_explosion: 'looks',
  explode: 'looks',
  show_name: 'looks',
  print_message: 'looks',
  play_sound: 'looks',

  modify_property: 'physics',
  negate_part: 'physics',
  de_negate_part: 'physics',
  add_body_mover: 'physics',
  remove_body_mover: 'physics',

  kill_player: 'players',
  heal_player: 'players',
  modify_player_health: 'players',
  set_health: 'players',
  set_player_speed: 'players',
  set_spawn_point: 'players',
  respawn_player: 'players',

  set_variable: 'variables',
  change_variable: 'variables',
  add_rule: 'variables',
};

/** Palette entry for one action type. */
export interface ActionCatalogEntry {
  type: ActionType;
  category: string;
  label: string;
  description: string;
}

/** The action palette, derived from the definitions (never hand-listed). */
export function buildActionCatalog(): ActionCatalogEntry[] {
  return ACTION_DEFINITIONS.map((d) => ({
    type: d.type,
    category: ACTION_CATEGORY[d.type] ?? 'looks',
    label: d.label,
    description: d.description,
  }));
}

/** Palette entry for one trigger type. */
export interface TriggerCatalogEntry {
  type: TriggerType;
  category: 'part' | 'game';
  label: string;
  description: string;
}

/** The trigger palette: part triggers (on objects) + game triggers. */
export function buildTriggerCatalog(): TriggerCatalogEntry[] {
  return TRIGGER_DEFINITIONS.map((d) => ({
    type: d.type,
    category: d.gameOnly ? 'game' : 'part',
    label: d.label,
    description: d.description,
  }));
}

// ─── Factories ───

let idCounter = 0;
/** Fresh unique id (rule_/act_/tpl_ prefixed). */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** A brand-new rule with the given trigger and one starter action slot. */
export function makeRule(triggerType: TriggerType, name?: string): WeildCodeRule {
  const def = TRIGGER_DEFINITIONS.find((d) => d.type === triggerType);
  const params: Record<string, any> = {};
  for (const p of def?.params ?? []) params[p.key] = p.default ?? '';
  return {
    id: newId('rule'),
    name: name || def?.label || 'New Rule',
    trigger: { type: triggerType, params },
    actions: [],
    mode: 'simple',
    enabled: true,
  };
}

/** A new action of the given type with all default params (children too). */
export function makeAction(type: ActionType, overrides?: Record<string, any>): WeildCodeAction {
  const action = createBlankAction(type);
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) action.params[k] = v;
  }
  return action;
}

/** Deep-clone a rule with FRESH ids (used by custom templates). */
export function cloneRuleWithNewIds(rule: WeildCodeRule): WeildCodeRule {
  const clone = (a: WeildCodeAction): WeildCodeAction => ({
    ...JSON.parse(JSON.stringify(a)),
    id: newId('act'),
    children: a.children?.map(clone),
    elseChildren: a.elseChildren?.map(clone),
  });
  return {
    ...JSON.parse(JSON.stringify(rule)),
    id: newId('rule'),
    actions: rule.actions.map(clone),
  };
}

// ─── Custom rule templates (device-local, same store key as v1) ───

export interface CustomTemplate {
  id: string;
  name: string;
  rule: WeildCodeRule;
}

export const CUSTOM_TEMPLATES_KEY = 'wb-block-templates';

// ─── Operand helpers (the IF condition's two sides) ───

/** Human summary of an operand for the block's collapsed label. */
export function operandSummary(op: any): string {
  if (!op || typeof op !== 'object') return '0';
  const o = op as OperandSpec;
  switch (o.source) {
    case 'player': return `player ${o.stat ?? 'health'}`;
    case 'part': return `${o.value || 'this part'}'s ${o.prop ?? 'x'}`;
    case 'variable': return o.value ? `var ${o.value}` : 'var ?';
    case 'text': return `"${o.value ?? ''}"`;
    case 'number':
    default: return String(o.value ?? '0');
  }
}

/** Rebuild an operand when its source changes (keeps a sensible value). */
export function operandForSource(op: any, source: OperandSpec['source']): OperandSpec {
  const prev = (op && typeof op === 'object' ? op : {}) as Partial<OperandSpec>;
  const next = createBlankOperand(source);
  if (source === 'variable' || source === 'text' || source === 'part') {
    next.value = typeof prev.value === 'string' ? prev.value : '';
  } else if (source === 'number') {
    next.value = '0';
  }
  if (source === 'part' && prev.prop) next.prop = prev.prop;
  if (source === 'player' && prev.stat) next.stat = prev.stat;
  return next;
}

// ─── The color quick-picks (same palette the old editor offered) ───

export const COLOR_SWATCHES: [string, string][] = [
  ['#ffffff', 'White'], ['#000000', 'Black'], ['#999999', 'Grey'],
  ['#ff0000', 'Red'], ['#ff6600', 'Orange'], ['#ffcc00', 'Amber'],
  ['#ffff00', 'Yellow'], ['#37e62e', 'Green'], ['#00cccc', 'Turquoise'],
  ['#4a90d9', 'Blue'], ['#3333ff', 'Bright Blue'], ['#6633ff', 'Violet'],
  ['#ff99ff', 'Pink'], ['#666333', 'Brown'], ['#4ff7f5', 'Aqua'],
  ['#ffeb3b', 'Light Yellow'], ['#ff6666', 'Light Red'], ['#666666', 'Dark Grey'],
];

/** The built-in $(...) text variables offered by the value picker. */
export const BUILTIN_TEXT_VARS = ['username', 'health', 'maxHealth', 'speed'];
