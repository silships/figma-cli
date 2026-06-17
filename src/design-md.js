/**
 * DESIGN.md importer.
 *
 * Parses the "Machine-readable tokens" JSON block at the end of a DESIGN.md
 * (the format produced by Figma extraction tools like figma-extract.md, the
 * `tokens-studio` exporter, and similar). Returns a normalized token map
 * ready for figma-cli's `tokens import` pipeline.
 *
 * Expected document layout:
 *   ## 11. Machine-readable tokens
 *   ```json design-tokens
 *   { "color": {...}, "typography": {...}, "spacing": {...},
 *     "radius": {...}, "shadow": {...}, "fonts": [...] }
 *   ```
 *
 * Section 7 ("Components") and the various tables (Color, Typography, Radius)
 * earlier in the file are summarized into a compact context string so the
 * `/design` command in figmachat can drop a token + component list into its
 * system prompt without bloating it with 7000 lines of structure.
 */

import fs from 'fs';
import YAML from 'yaml';

const JSON_BLOCK_RE = /```json\s+design-tokens\s*\n([\s\S]*?)\n```/;

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** Normalize a value like "16px" / "1.5px" / "9999px" into a plain number, or
 * pass through unchanged if it's not a px-suffixed number. */
function stripPx(v) {
  if (typeof v !== 'string') return v;
  const m = v.match(/^([\d.]+)\s*px$/);
  return m ? parseFloat(m[1]) : v;
}

/**
 * Convert a getdesign.md / awesome-design-md style YAML frontmatter design
 * spec (top-level `colors:`, `typography:`, `rounded:` / `radius:`,
 * `spacing:`, optional `components:`) into the same shape our internal
 * pipeline expects: `{ color, typography, radius, spacing, shadow, fonts, meta }`.
 */
function normalizeYamlSpec(spec) {
  const out = { color: {}, typography: {}, radius: {}, spacing: {}, shadow: {}, meta: {} };
  // colors (both `colors:` and `color:` are accepted) — map to the SHARED
  // canonical names (same as the prose path) so every collection switches cleanly.
  const colors = spec.colors || spec.color || {};
  const colorRows = [];
  for (const [k, v] of Object.entries(colors)) {
    const hex = typeof v === 'string' ? v : (v && typeof v.value === 'string' ? v.value : null);
    if (!hex) continue;
    const role = yamlRole(k);
    if (!role) continue;                 // skip on-* helpers
    colorRows.push({ name: k, color: hex, role });
  }
  out.color = assignCanonical(colorRows);
  // typography — figma-cli's importer expects { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing }
  const ty = spec.typography || {};
  for (const [name, t] of Object.entries(ty)) {
    if (typeof t !== 'object') continue;
    out.typography[name] = {
      fontFamily: t.fontFamily,
      fontSize: stripPx(t.fontSize),
      fontWeight: t.fontWeight,
      lineHeight: t.lineHeight,
      letterSpacing: t.letterSpacing,
    };
  }
  // radii — accept `rounded:` (Stitch style), `radius:` (our style), `radii:`
  const radii = spec.rounded || spec.radius || spec.radii || {};
  for (const [k, v] of Object.entries(radii)) {
    const n = typeof v === 'number' ? v : stripPx(v);
    if (typeof n === 'number') out.radius[k] = n;
  }
  // spacing
  const sp = spec.spacing || {};
  for (const [k, v] of Object.entries(sp)) {
    const n = typeof v === 'number' ? v : stripPx(v);
    if (typeof n === 'number') out.spacing[k] = n;
  }
  // shadows — keep as-is, we don't auto-create variables from these yet
  if (spec.shadows) out.shadow = spec.shadows;
  if (spec.shadow) out.shadow = spec.shadow;
  // meta
  out.meta = {
    source: spec.name || spec.title,
    generated: spec.version || spec.date,
  };
  // components (just names — useful for the figmachat context)
  if (spec.components && typeof spec.components === 'object') {
    out._componentNames = Object.keys(spec.components);
  }
  return out;
}

/** Slugify a display name into a token-safe key: "Cursor Cream" -> "cursor-cream". */
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Classify a PROSE color row by its role, from name + description text.
 * (Prose descriptions say "Brand accent" / "Page background, primary surface",
 *  so we read intent from the words — "primary" alone is NOT enough to mean
 *  accent because "primary surface" is a background.) */
function roleOf(name, desc) {
  const b = `${name} ${desc}`.toLowerCase();
  if (/\b(cta|accent|brand|link)\b/.test(b)) return 'accent';
  if (b.includes('page background') || b.includes('primary surface') ||
      b.includes('canvas') || (b.includes('page') && b.includes('background'))) return 'bg';
  if (b.includes('text') || b.includes('heading')) return 'text';
  if (b.includes('surface') || b.includes('card') || b.includes('background')) return 'surface';
  if (b.includes('border') || b.includes('hairline')) return 'border';
  return 'other';
}

/** Classify a YAML token by its KEY name (keys are already semantic: primary,
 * ink, canvas, surface-tile-1, …). `on-*` (text-on-color helpers) are skipped. */
function yamlRole(key) {
  const k = key.toLowerCase();
  if (/^on-/.test(k)) return null;
  if (/(primary|accent|brand|cta|action|link|focus)/.test(k)) return 'accent';
  if (/(ink|body|text|heading|foreground)/.test(k)) return 'text';
  if (/(canvas|background|page|base)/.test(k)) return 'bg';
  if (/(surface|tile|card|panel|sheet|elevated|pearl)/.test(k)) return 'surface';
  if (/(border|hairline|divider|stroke|rule)/.test(k)) return 'border';
  return 'other';
}

// Shared canonical vocabulary. EVERY design system imports under these same
// names so `figma-cli use <collection>` can switch a design cleanly between
// brands (cursor ↔ stripe ↔ apple) — name-matching only works if names match.
const CANON_NAMES = {
  bg: ['canvas', 'canvas-subtle'],
  text: ['ink', 'body'],
  accent: ['primary', 'accent'],
  surface: ['surface', 'surface-2', 'surface-3', 'surface-4'],
  border: ['hairline', 'border-strong'],
  other: [],
};

/** Map role-tagged color rows ([{name, color, role}]) to the shared canonical
 * names; overflow beyond the canonical slots keeps a slugged name. */
function assignCanonical(rows) {
  const color = {};
  const used = new Set();
  const assign = (base, hex) => {
    let n = base, i = 2;
    while (used.has(n)) n = `${base}-${i++}`;
    used.add(n);
    color[n] = hex;
  };
  for (const role of ['bg', 'text', 'accent', 'surface', 'border', 'other']) {
    rows.filter(r => r.role === role).forEach((r, idx) => {
      const canon = CANON_NAMES[role][idx];
      assign(canon || slugify(r.name), r.color);
    });
  }
  return color;
}

// Prose color rows: `**Cursor Cream** (`#f2f1ed`): Page background, primary surface`
const PROSE_COLOR_ROW = /\*\*(.+?)\*\*\s*\(`([^`]+)`\)\s*:\s*([^.\n]+)/g;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Format C: prose DESIGN.md (awesome-design-md brand style) with role-labelled
 * color rows but no machine-readable block. Buckets rows by role and assigns
 * the canonical semantic names figma-cli/figmachat expect (canvas, ink,
 * primary, …), falling back to slugged display names for the rest. Returns the
 * normalized token shape, or null if the file isn't a prose design system.
 */
function parseProseSpec(text) {
  const rows = [];
  const seen = new Set();
  let m;
  PROSE_COLOR_ROW.lastIndex = 0;
  while ((m = PROSE_COLOR_ROW.exec(text)) !== null) {
    const color = m[2].trim();
    if (!HEX_RE.test(color)) continue;            // Figma vars need RGB; skip oklab/rgba
    const key = color.toLowerCase();
    if (seen.has(key)) continue;                  // dedupe by hex
    seen.add(key);
    rows.push({ name: m[1].trim(), color, desc: m[3].trim(), role: roleOf(m[1], m[3]) });
  }
  if (rows.length < 2) return null;               // 2 = a legit B&W system (e.g. Figma)
  return { color: assignCanonical(rows), typography: {}, radius: {}, spacing: {}, shadow: {}, meta: {} };
}

export function parseDesignMd(filepath) {
  const text = fs.readFileSync(filepath, 'utf-8');

  // Format A: YAML frontmatter (Stitch / getdesign.md / awesome-design-md style)
  const fmMatch = text.match(FRONTMATTER_RE);
  if (fmMatch) {
    let spec;
    try {
      spec = YAML.parse(fmMatch[1]);
    } catch (e) {
      throw new Error(`YAML frontmatter in ${filepath} is not valid: ${e.message}`);
    }
    if (spec && (spec.colors || spec.color || spec.typography)) {
      const tokens = normalizeYamlSpec(spec);
      return {
        tokens,
        meta: {
          source: tokens.meta.source || filepath.split('/').pop().replace(/\.md$/, ''),
          generated: tokens.meta.generated,
          identity: spec.description,
          components: tokens._componentNames || [],
        },
      };
    }
    // Otherwise fall through to Format B detection
  }

  // Format B: `## Machine-readable tokens` + ```json design-tokens block
  // (our original DESIGN.md extraction format)
  const match = text.match(JSON_BLOCK_RE);
  if (match) {
    let tokens;
    try {
      tokens = JSON.parse(match[1]);
    } catch (e) {
      throw new Error(`Token JSON block is not valid JSON: ${e.message}`);
    }

    // Pull the document summary fields too — useful for the figmachat context.
    const identityMatch = text.match(/^\*\*In one line:\*\*\s+(.+)$/m);
    const sourceMatch = text.match(/^source:\s+(.+)$/m);
    const componentSections = [...text.matchAll(/^### Page:\s+(.+)$/gm)]
      .map(m => m[1].trim())
      .filter(p => !/^(About|Read me|Color|Effects|Spacing block|Screens|Utilities)$/i.test(p));

    return {
      tokens,
      meta: {
        source: tokens.meta?.source || sourceMatch?.[1] || 'unknown',
        generated: tokens.meta?.generated,
        identity: identityMatch?.[1],
        components: componentSections,
      },
    };
  }

  // Format C: prose DESIGN.md (awesome-design-md brand style) — role-labelled
  // `**Name** (`#hex`): role` rows, no machine-readable block.
  const proseTokens = parseProseSpec(text);
  if (proseTokens) {
    return {
      tokens: proseTokens,
      meta: {
        source: filepath.split('/').pop().replace(/\.md$/, ''),
        identity: text.match(/^#\s+(.+)$/m)?.[1],
        components: [],
      },
    };
  }

  throw new Error(
    `Couldn't parse ${filepath}. Expected one of:\n` +
    `  - YAML frontmatter with top-level \`colors:\` / \`typography:\` (Stitch / getdesign.md style)\n` +
    `  - "## Machine-readable tokens" section with a \`\`\`json design-tokens\`\`\` block\n` +
    `  - prose color rows like \`**Name** (\`#hex\`): role\` (awesome-design-md style)`
  );
}

/** Produce a one-shot summary string for figmachat to drop into the system prompt. */
export function summarizeForLLM({ tokens, meta }) {
  const colors = Object.entries(tokens.color || {});
  const types = Object.keys(tokens.typography || {});
  const radii = Object.keys(tokens.radius || {});
  const shadows = Object.keys(tokens.shadow || {});

  const lines = [
    `Design system loaded: ${meta.source}`,
  ];
  if (meta.identity) lines.push(`Style: ${meta.identity}`);

  // Color tokens — list the first 40 by usage (the file already orders them
  // by usage count). Naming this section explicitly so the model knows these
  // are the canonical token names to use in `var:` references.
  if (colors.length) {
    const sample = colors.slice(0, 40)
      .map(([k, v]) => `var:${k}=${v}`)
      .join(', ');
    lines.push(`Color tokens (${colors.length} total, top by usage): ${sample}`);
    if (colors.length > 40) lines.push(`  …and ${colors.length - 40} more — call \`figma-cli var list\` for the full set.`);
  }
  if (types.length) lines.push(`Typography tokens (${types.length}): ${types.join(', ')}`);
  if (radii.length) lines.push(`Radius tokens (${radii.length}): ${radii.join(', ')}`);
  if (shadows.length) lines.push(`Shadow tokens (${shadows.length}): use sparingly — they're long compositions`);
  if (meta.components?.length) {
    // Normalize: components may be strings (from parseDesignMd) or objects
    // {name, variants, category} (from storybook parser). Map to display strings.
    const compNames = meta.components.slice(0, 50).map(c =>
      typeof c === 'string' ? c : `${c.name} (${c.variants?.length ?? 0} variants)`
    );
    lines.push(`Existing component pages: ${compNames.join(', ')}`);
  }
  lines.push('');
  lines.push(`HARD RULES while this design system is loaded:`);
  lines.push(`- ALWAYS use \`bg="var:<name>"\` / \`color="var:<name>"\` for colors, never raw hex.`);
  lines.push(`- For text styles, match by purpose to the typography token names above.`);
  lines.push(`- For radii, match by name (e.g. radius-md = 2px).`);
  lines.push(`- If the user asks for a component already listed under "Existing component pages", PREFER using the existing component over creating a new one. Hint: 'figma-cli find "<name>"' to locate it.`);
  return lines.join('\n');
}

/** Build the JSON payload that figma-cli's `tokens import` already consumes. */
export function toTokensImportJson({ tokens }) {
  // figma-cli `tokens import` accepts a flat or nested map. We flatten color
  // / radius into the W3C-token-spec-ish shape it already understands.
  const out = {
    color: {},
    radius: {},
    typography: {},
  };
  for (const [name, value] of Object.entries(tokens.color || {})) {
    out.color[name] = { value, type: 'color' };
  }
  for (const [name, value] of Object.entries(tokens.radius || {})) {
    const num = parseFloat(value);
    if (Number.isFinite(num)) out.radius[name] = { value: num, type: 'number' };
  }
  for (const [name, ts] of Object.entries(tokens.typography || {})) {
    out.typography[name] = {
      value: {
        fontFamily: ts.fontFamily,
        fontSize: ts.fontSize,
        fontWeight: ts.fontWeight,
        lineHeight: ts.lineHeight,
        letterSpacing: ts.letterSpacing,
      },
      type: 'typography',
    };
  }
  return out;
}

/**
 * Build the eval source that recreates real variable collections from a
 * DESIGN.md `variables` block (the shape buildVariableTokens emits):
 *   { [collectionName]: { modes: [name…], variables: { [name]: { type, values } } } }
 * where each value is a hex string / number / bool / string, or { alias: name }.
 *
 * Two passes so alias chains resolve regardless of declaration order:
 *   1. create every collection, its modes, and every variable with its
 *      non-alias values; register names for lookup.
 *   2. set alias values by resolving the target NAME to a created/pre-existing
 *      variable (same-collection match preferred, else first global match).
 *
 * Idempotent: existing collections/variables are reused, not duplicated.
 * Returns a JSON.stringify'd { collections, createdCount, aliasCount, unresolved }.
 * Pure string builder (no Figma access here) so it is unit-testable.
 */
export function variableImportCode(variables) {
  return `(async () => {
  const VARS = ${JSON.stringify(variables)};
  const hexToRgba = (hex) => {
    const m = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})?$/i.exec(String(hex).trim());
    if (!m) return null;
    return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255, a: m[4] != null ? parseInt(m[4], 16) / 255 : 1 };
  };
  const TYPES = { COLOR: 1, FLOAT: 1, STRING: 1, BOOLEAN: 1 };
  const existingCols = await figma.variables.getLocalVariableCollectionsAsync();
  const allVars = await figma.variables.getLocalVariablesAsync();
  const byName = new Map();
  const register = (v) => { const a = byName.get(v.name) || []; a.push(v); byName.set(v.name, a); };
  allVars.forEach(register);

  const ctx = {};
  let createdCount = 0, aliasCount = 0, unresolved = 0;

  // PASS 1 — collections, modes, variables, non-alias values
  for (const [collName, coll] of Object.entries(VARS)) {
    let col = existingCols.find(c => c.name === collName);
    if (!col) col = figma.variables.createVariableCollection(collName);
    const modeNames = (coll.modes && coll.modes.length) ? coll.modes : ['Mode 1'];
    const modeIds = {};
    for (let i = 0; i < modeNames.length; i++) {
      const mn = modeNames[i];
      let m = col.modes.find(x => x.name === mn);
      if (!m) {
        if (i === 0 && col.modes.length === 1) { col.renameMode(col.modes[0].modeId, mn); m = col.modes[0]; }
        else { try { const id = col.addMode(mn); m = col.modes.find(x => x.modeId === id); } catch (e) { m = col.modes[0]; } }
      }
      modeIds[mn] = m.modeId;
    }
    const vars = {};
    for (const [vName, vDef] of Object.entries(coll.variables || {})) {
      const type = TYPES[vDef.type] ? vDef.type : 'STRING';
      let v = allVars.find(x => x.name === vName && x.variableCollectionId === col.id) || vars[vName];
      if (!v) { try { v = figma.variables.createVariable(vName, col, type); register(v); createdCount++; } catch (e) { continue; } }
      vars[vName] = v;
      for (const [mn, val] of Object.entries(vDef.values || {})) {
        const modeId = modeIds[mn];
        if (modeId == null) continue;
        if (val && typeof val === 'object' && 'alias' in val) continue; // pass 2
        try {
          if (type === 'COLOR') { const rgba = hexToRgba(val); if (rgba) v.setValueForMode(modeId, rgba); }
          else if (type === 'FLOAT') { if (typeof val === 'number') v.setValueForMode(modeId, val); }
          else if (type === 'BOOLEAN') v.setValueForMode(modeId, !!val);
          else v.setValueForMode(modeId, String(val));
        } catch (e) {}
      }
    }
    ctx[collName] = { modeIds, vars };
  }

  // PASS 2 — alias values, resolved by target name
  for (const [collName, coll] of Object.entries(VARS)) {
    const c = ctx[collName];
    if (!c) continue;
    for (const [vName, vDef] of Object.entries(coll.variables || {})) {
      const v = c.vars[vName];
      if (!v) continue;
      for (const [mn, val] of Object.entries(vDef.values || {})) {
        if (!(val && typeof val === 'object' && 'alias' in val)) continue;
        const modeId = c.modeIds[mn];
        if (modeId == null) continue;
        let target = c.vars[val.alias];
        if (!target) { const cand = byName.get(val.alias); if (cand && cand.length) target = cand[0]; }
        if (!target) { unresolved++; continue; }
        try { v.setValueForMode(modeId, figma.variables.createVariableAlias(target)); aliasCount++; }
        catch (e) { unresolved++; }
      }
    }
  }

  return JSON.stringify({ collections: Object.keys(VARS).length, createdCount, aliasCount, unresolved });
})()`;
}
