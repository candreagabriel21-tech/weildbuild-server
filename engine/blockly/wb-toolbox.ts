// ═══════════════════════════════════════════════════════════════════
// WeildBuild — Blockly toolbox builder (v1.6)
// ═══════════════════════════════════════════════════════════════════
// Builds the toolbox XML for the Code editor:
//   • normal mode: category tree (events, movement, appearance, ... math,
//     variables with a "Create variable" button, control, parts, custom rules)
//   • search mode: one "Results" category with every block matching the
//     query (labels, descriptions, keywords) plus matching custom rules
// Custom rules are device-local templates (localStorage, same store the
// old editor used) rendered as ready-made stacks in the flyout.

import { WeildCodeRule } from '../weildcode-types';
import { buildCategories, getSearchIndex, blockShadowXml } from './wb-blocks';
import { ruleToBlockXml } from './wb-compile';

export interface CustomTemplate {
  id: string;
  name: string;
  rule: WeildCodeRule;
}

/** Flyout item for a block type, with shadow literals on every
 * number/text/vector3 socket (v1.7) so freshly dragged blocks are
 * immediately usable: type into the pill, or drop a real block on it. */
function flyoutBlock(type: string): string {
  switch (type) {
    case 'wb_var_set':
      return `<block type="wb_var_set"><value name="TO"><shadow type="wb_text"><field name="TEXT">0</field></shadow></value></block>`;
    case 'wb_var_change':
      return `<block type="wb_var_change"><value name="BY"><shadow type="wb_math_number"><field name="NUM">1</field></shadow></value></block>`;
    case 'wb_math_arithmetic':
      return `<block type="wb_math_arithmetic">`
        + `<value name="A"><shadow type="wb_math_number"><field name="NUM">1</field></shadow></value>`
        + `<value name="B"><shadow type="wb_math_number"><field name="NUM">1</field></shadow></value>`
        + `</block>`;
    case 'wb_math_single':
      return `<block type="wb_math_single"><value name="A"><shadow type="wb_math_number"><field name="NUM">1</field></shadow></value></block>`;
    case 'wb_math_minmax':
      return `<block type="wb_math_minmax">`
        + `<value name="A"><shadow type="wb_math_number"><field name="NUM">1</field></shadow></value>`
        + `<value name="B"><shadow type="wb_math_number"><field name="NUM">1</field></shadow></value>`
        + `</block>`;
    default:
      // Trigger + action blocks: shadows generated from their param
      // definitions (number/text/vector3 sockets only).
      return `<block type="${type}">${blockShadowXml(type)}</block>`;
  }
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the toolbox XML.
 *   mode      object rules vs game rules (filters the catalog)
 *   search    search query ("" = normal category tree)
 *   templates saved custom rules (device-local)
 */
export function buildToolboxXml(mode: 'object' | 'game', search: string, templates: CustomTemplate[]): string {
  const q = search.trim().toLowerCase();

  // ── Search mode: one Results category ──
  if (q) {
    const validTypes = new Set(buildCategories(mode).flatMap((c) => c.types));
    const seen = new Set<string>();
    const items: string[] = [];
    for (const entry of getSearchIndex()) {
      if (seen.has(entry.type) || !validTypes.has(entry.type)) continue;
      if (entry.text.includes(q)) {
        seen.add(entry.type);
        items.push(flyoutBlock(entry.type));
      }
    }
    for (const t of templates) {
      if (t.name.toLowerCase().includes(q)) items.push(ruleToBlockXml(t.rule));
    }
    if (items.length === 0) {
      items.push('<label text="No blocks match that search."></label>');
    }
    return `<xml><category name="Results (${items.length})" colour="230" expanded="true">${items.join('')}</category></xml>`;
  }

  // ── Normal mode: the category tree ──
  const parts: string[] = [];
  for (const cat of buildCategories(mode)) {
    const inner: string[] = [];
    if (cat.id === 'variables') {
      inner.push('<button text="Create variable..." callbackKey="wbCreateVariable"></button>');
    }
    for (const type of cat.types) inner.push(flyoutBlock(type));
    parts.push(`<category name="${esc(cat.label)}" colour="${cat.colour}">${inner.join('')}</category>`);
  }

  // Custom rules category (always last)
  if (templates.length === 0) {
    parts.push(
      `<category name="Custom Rules" colour="120">`
      + '<label text="Right click a trigger block and pick"></label>'
      + '<label text="Save as custom rule to build this list."></label>'
      + `</category>`,
    );
  } else {
    const inner = templates.map((t) => ruleToBlockXml(t.rule)).join('');
    parts.push(`<category name="Custom Rules (${templates.length})" colour="120">${inner}</category>`);
  }

  return `<xml>${parts.join('')}</xml>`;
}
