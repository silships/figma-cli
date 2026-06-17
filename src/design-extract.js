/**
 * DESIGN.md exporter — the reverse of src/design-md.js.
 *
 * Three units:
 *  1. walkerCode()/listPagesCode(): JS strings evaluated INSIDE Figma
 *     (async IIFEs returning JSON.stringify'd compact node trees).
 *  2. Aggregator: pure functions building color/typography/spacing/radius/
 *     shadow censuses, semantic names, variant matrices from walker JSON.
 *  3. generateDesignMd(): emits the 11-section plugin-compatible markdown
 *     that parseDesignMd() (src/design-md.js) reads back unchanged.
 */

/** Eval snippet: list all pages of the open file. */
export function listPagesCode() {
  return `(async () => {
    await figma.loadAllPagesAsync();
    return JSON.stringify(figma.root.children.map(p => ({ id: p.id, name: p.name, frames: p.children.length })));
  })()`;
}

/**
 * Eval snippet: capture every LOCAL variable collection of the open file —
 * names, modes, and each variable's per-mode resolved value. This is the
 * authoritative token layer (e.g. Primer's `button-primary-bgColor-rest`),
 * which the derived color palette can only approximate by sampling fills.
 *
 * COLOR values resolve to hex (8-digit when alpha < 1), FLOAT/STRING/BOOLEAN
 * pass through, and VARIABLE_ALIAS values are captured as { alias: <id> } for
 * Node-side name resolution. Self-contained for the plugin sandbox.
 */
/**
 * Shared eval helpers spliced into the variable-reading IIFEs: hex(),
 * aliasName() (cached id→name, resolves library/remote refs too), and
 * readVarValues(v, modes) → { modeName: value } applying the COLOR→hex /
 * alias / passthrough rules. Single-sourced so the one-shot and chunked
 * paths can never drift.
 */
const VAR_EVAL_HELPERS = `
    const hex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('') + (c.a != null && c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, '0') : '');
    const nameCache = new Map();
    const aliasName = async (id) => {
      if (nameCache.has(id)) return nameCache.get(id);
      let name = id;
      try { const t = await figma.variables.getVariableByIdAsync(id); if (t) name = t.name; } catch (e) {}
      nameCache.set(id, name);
      return name;
    };
    const readVarValues = async (v, modes) => {
      const values = {};
      for (const m of modes) {
        const raw = v.valuesByMode[m.id];
        if (raw == null) continue;
        if (typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') values[m.name] = { alias: await aliasName(raw.id) };
        else if (v.resolvedType === 'COLOR' && raw && typeof raw === 'object' && 'r' in raw) values[m.name] = hex(raw);
        else values[m.name] = raw;
      }
      return values;
    };`;

export function variablesCode() {
  return `(async () => {${VAR_EVAL_HELPERS}
    let cols = [];
    try { cols = await figma.variables.getLocalVariableCollectionsAsync(); } catch (e) { return JSON.stringify([]); }
    const out = [];
    for (const col of cols) {
      const modes = col.modes.map(m => ({ id: m.modeId, name: m.name }));
      const variables = [];
      for (const id of col.variableIds) {
        let v;
        try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { continue; }
        if (!v) continue;
        variables.push({ id: v.id, name: v.name, type: v.resolvedType, values: await readVarValues(v, modes) });
      }
      out.push({ id: col.id, name: col.name, modes, variables });
    }
    return JSON.stringify(out);
  })()`;
}

/**
 * Eval snippet: list variable collections WITHOUT reading any values — just
 * id, name, modes and the variableIds. Tiny payload even for huge systems;
 * the command then fetches values in bounded chunks (variableChunkCode) so a
 * 10k-variable library never lands in one oversized/timing-out eval.
 */
export function variableCollectionsCode() {
  return `(async () => {
    let cols = [];
    try { cols = await figma.variables.getLocalVariableCollectionsAsync(); } catch (e) { return JSON.stringify([]); }
    return JSON.stringify(cols.map(c => ({ id: c.id, name: c.name, modes: c.modes.map(m => ({ id: m.modeId, name: m.name })), variableIds: c.variableIds })));
  })()`;
}

/**
 * Eval snippet: read one chunk of variables by explicit id list, for the given
 * modes ([{ id, name }]). Returns [{ id, name, type, values }]. Self-contained;
 * the alias name cache is per-chunk (fresh sandbox), which costs a few extra
 * lookups but keeps each call independent and retryable at a smaller size.
 */
export function variableChunkCode(ids, modes) {
  return `(async () => {${VAR_EVAL_HELPERS}
    const modes = ${JSON.stringify(modes)};
    const ids = ${JSON.stringify(ids)};
    const variables = [];
    for (const id of ids) {
      let v;
      try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { continue; }
      if (!v) continue;
      variables.push({ id: v.id, name: v.name, type: v.resolvedType, values: await readVarValues(v, modes) });
    }
    return JSON.stringify(variables);
  })()`;
}

/**
 * Eval snippet: walk one page and return its compact node tree.
 * Kept self-contained — no outer-scope references — because it runs in the
 * Figma plugin sandbox.
 */
export function walkerCode(pageId, { maxDepth = 8, textLimit = 80 } = {}) {
  return `(async () => {
    const MAX_DEPTH = ${Number(maxDepth)};
    const TEXT_LIMIT = ${Number(textLimit)};
    const hex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    const paints = (arr) => {
      if (!Array.isArray(arr)) return undefined;
      const out = [];
      for (const p of arr) {
        if (p.visible === false) continue;
        if (p.type === 'SOLID') out.push(hex(p.color) + (p.opacity != null && p.opacity < 1 ? '@' + Math.round(p.opacity * 100) : ''));
        else out.push(p.type);
      }
      return out.length ? out : undefined;
    };
    const walk = (n, depth) => {
      const o = { t: n.type, n: n.name };
      if ('width' in n) { o.w = Math.round(n.width); o.h = Math.round(n.height); }
      if ('layoutMode' in n && n.layoutMode !== 'NONE') {
        o.lm = n.layoutMode;
        if (n.itemSpacing) o.gap = n.itemSpacing;
        const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
        if (pad.some(v => v > 0)) o.pad = pad;
      }
      try { const f = paints(n.fills); if (f) o.fills = f; } catch (e) {}
      try { const s = paints(n.strokes); if (s) { o.strokes = s; if (typeof n.strokeWeight === 'number') o.sw = n.strokeWeight; } } catch (e) {}
      if ('cornerRadius' in n) {
        if (typeof n.cornerRadius === 'number') { if (n.cornerRadius > 0) o.r = n.cornerRadius; }
        else o.r = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
      }
      if (Array.isArray(n.effects) && n.effects.length) {
        const fx = n.effects.filter(e => e.visible !== false).map(e =>
          (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
            ? { type: e.type, x: e.offset.x, y: e.offset.y, blur: e.radius, spread: e.spread || 0, color: hex(e.color), a: Math.round((e.color.a == null ? 1 : e.color.a) * 100) / 100 }
            : { type: e.type, blur: e.radius });
        if (fx.length) o.fx = fx;
      }
      if (n.type === 'TEXT') {
        o.txt = { chars: (n.characters || '').slice(0, TEXT_LIMIT) };
        if (n.fontName !== figma.mixed) { o.txt.font = n.fontName.family; o.txt.style = n.fontName.style; }
        if (n.fontSize !== figma.mixed) o.txt.size = n.fontSize;
        if (n.lineHeight !== figma.mixed && n.lineHeight && n.lineHeight.unit !== 'AUTO') {
          // PERCENT line-heights are relative to font size; resolve to absolute
          // px so the table/JSON tokens are unambiguous and re-import cleanly.
          // (A raw 142.85 from "142%" would otherwise read as 142.85px.)
          if (n.lineHeight.unit === 'PERCENT') {
            if (o.txt.size != null) o.txt.lh = Math.round(o.txt.size * n.lineHeight.value / 100 * 10) / 10;
          } else {
            o.txt.lh = n.lineHeight.value;
          }
        }
        if (n.letterSpacing !== figma.mixed && n.letterSpacing && n.letterSpacing.value) o.txt.ls = n.letterSpacing.value;
      }
      if (n.type === 'COMPONENT_SET') {
        try { o.vp = n.variantGroupProperties; } catch (e) {}
        o.kidCount = n.children.length;
        // Reuse handle: the default variant is the COMPONENT you instance
        // (a set has no createInstance). Capture its node id (same-file reuse)
        // and publish key (cross-file reuse, only resolvable once published).
        const dv = n.defaultVariant || n.children[0];
        if (dv) { o.id = dv.id; try { o.key = dv.key; } catch (e) {} }
        if (n.children.length) o.kids = [walk(n.children[0], depth + 1)];
        return o;
      }
      if (n.type === 'INSTANCE') { o.mc = n.name; return o; }
      if ('children' in n && n.children.length) {
        if (depth >= MAX_DEPTH) { o.more = n.children.length; return o; }
        o.kids = n.children.map(c => walk(c, depth + 1));
      }
      return o;
    };
    const page = await figma.getNodeByIdAsync(${JSON.stringify(String(pageId))});
    if (!page) return JSON.stringify({ error: 'page not found' });
    if (typeof page.loadAsync === 'function') await page.loadAsync();
    let visited = 0;
    const count = (n) => { visited++; if ('children' in n) n.children.forEach(count); };
    count(page);
    return JSON.stringify({ id: page.id, name: page.name, nodeCount: visited, frames: page.children.map(c => walk(c, 0)) });
  })()`;
}

// ============ Aggregator (pure, Node-side) ============

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

/** Hex '#rrggbb' → { h, s, l } each 0..1 (h 0..360). */
export function hexToHsl(hexStr) {
  const v = hexStr.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/**
 * Walk all page trees and count every design decision.
 * Returns { colors, typography, radii, spacing, shadows: Map, fonts: Set,
 *           componentSets: [{name, page, props, variants, sample}] }.
 * Color keys are bare hex (opacity suffix stripped); typography keys are
 * 'family|style|size|lh|ls'.
 */
export function buildCensus(pages) {
  const census = {
    colors: new Map(), typography: new Map(), radii: new Map(),
    spacing: new Map(), shadows: new Map(), fonts: new Set(), componentSets: [],
  };
  const visitPaints = (arr) => (arr || []).forEach(p => {
    if (typeof p === 'string' && p.startsWith('#')) bump(census.colors, p.split('@')[0]);
  });
  const visit = (n, pageName) => {
    visitPaints(n.fills);
    visitPaints(n.strokes);
    if (n.gap > 0) bump(census.spacing, n.gap);
    (n.pad || []).forEach(v => { if (v > 0) bump(census.spacing, v); });
    if (n.r != null) (Array.isArray(n.r) ? n.r : [n.r]).forEach(v => { if (v > 0) bump(census.radii, v); });
    (n.fx || []).forEach(e => bump(census.shadows, JSON.stringify(e)));
    if (n.txt && n.txt.font) {
      census.fonts.add(n.txt.font);
      bump(census.typography, [n.txt.font, n.txt.style || '', n.txt.size ?? '', n.txt.lh ?? '', n.txt.ls ?? ''].join('|'));
    }
    if (n.t === 'COMPONENT_SET') {
      census.componentSets.push({ name: n.n, page: pageName, props: n.vp || {}, variants: n.kidCount || 0, sample: n.kids?.[0], key: n.key, id: n.id });
    }
    (n.kids || []).forEach(k => visit(k, pageName));
  };
  for (const page of pages) (page.frames || []).forEach(f => visit(f, page.name));
  return census;
}

/**
 * Rank colors by usage and assign the semantic names the plugin format uses
 * (background, surface, text-primary, text-secondary, text-tertiary, border,
 * accent — with -alt / -3 / -4 suffixes for repeats within a role).
 * Input: Map<hex, count>. Output: { name: hex } ordered by usage.
 */
export function assignSemanticNames(colors) {
  const roleOf = (hex) => {
    const { s, l } = hexToHsl(hex);
    if (s > 0.25 && l > 0.08 && l < 0.95) return 'accent';
    if (l >= 0.97) return 'background';
    if (l >= 0.85) return 'surface';
    if (l >= 0.6) return 'border';
    if (l >= 0.45) return 'text-tertiary';
    if (l >= 0.25) return 'text-secondary';
    return 'text-primary';
  };
  const ranked = [...colors.entries()].sort((a, b) => b[1] - a[1]);
  const used = new Map(); // role → count so far
  const out = {};
  for (const [hex] of ranked) {
    const role = roleOf(hex);
    const nth = (used.get(role) || 0) + 1;
    used.set(role, nth);
    const name = nth === 1 ? role : nth === 2 ? `${role}-alt` : `${role}-${nth}`;
    out[name] = hex;
  }
  return out;
}

const WEIGHT_MAP = {
  thin: 100, extralight: 200, 'extra light': 200, light: 300, regular: 400,
  medium: 500, semibold: 600, 'semi bold': 600, bold: 700,
  extrabold: 800, 'extra bold': 800, black: 900,
};

/** 'Semi Bold Italic' → 600. Unknown styles → 400. */
export function styleToWeight(style) {
  const s = String(style || '').toLowerCase().replace(/\s*italic\s*/, '').trim();
  return WEIGHT_MAP[s] || 400;
}

/**
 * Map a typography census (Map<'family|style|size|lh|ls', count>) onto the
 * scale names parseDesignMd's typography import understands:
 * display (>=36), h1..h6 (descending unique sizes >= body), body-lg, body,
 * body-sm, caption (<=12). Within a size, highest-usage entry wins the base
 * name; further entries get '-2', '-3' suffixes.
 */
export function buildTypeScale(typography) {
  const entries = [...typography.entries()].map(([key, count]) => {
    const [family, style, size, lh, ls] = key.split('|');
    return { family, style, size: parseFloat(size), lh: lh ? parseFloat(lh) : undefined, ls: ls ? parseFloat(ls) : undefined, count };
  }).filter(e => Number.isFinite(e.size));
  entries.sort((a, b) => b.size - a.size || b.count - a.count);

  const nameFor = (size, headingIdx) => {
    if (size >= 36) return 'display';
    if (size >= 18 && headingIdx <= 6) return `h${headingIdx}`;
    if (size >= 16) return 'body-lg';
    if (size >= 13) return 'body';
    if (size > 12) return 'body-sm';
    return 'caption';
  };
  const out = {};
  const usedNames = new Map();
  let headingIdx = 1;
  let lastHeadingSize = null;
  for (const e of entries) {
    let base = nameFor(e.size, headingIdx);
    if (base.startsWith('h')) {
      if (lastHeadingSize !== null && e.size < lastHeadingSize) headingIdx += 1;
      base = nameFor(e.size, headingIdx);
      lastHeadingSize = e.size;
    }
    const nth = (usedNames.get(base) || 0) + 1;
    usedNames.set(base, nth);
    const name = nth === 1 ? base : `${base}-${nth}`;
    out[name] = {
      fontFamily: e.family, fontSize: e.size, fontWeight: styleToWeight(e.style),
      ...(e.lh !== undefined ? { lineHeight: e.lh } : {}),
      ...(e.ls !== undefined ? { letterSpacing: e.ls } : {}),
    };
  }
  return out;
}

/** Most plausible base unit (2, 4 or 8) from a spacing census. Default 8. */
export function inferBaseUnit(spacing) {
  if (!spacing.size) return 8;
  const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
  const values = [...spacing.keys()].filter(v => Number.isFinite(v) && v > 0);
  if (!values.length) return 8;
  const g = values.reduce((acc, v) => gcd(acc, v));
  if (g >= 8) return 8;
  if (g >= 4) return 4;
  return 2;
}

/** Radius census → { 'radius-sm': 2, 'radius-md': 6, ... , 'radius-full': 9999 }. */
export function nameRadii(radii) {
  const values = [...radii.keys()].sort((a, b) => a - b);
  const out = {};
  const tiers = ['radius-sm', 'radius-md', 'radius-lg'];
  let tierIdx = 0;
  const usedNames = new Map();
  for (const v of values) {
    let base;
    if (v >= 999) base = 'radius-full';
    else { base = tiers[Math.min(tierIdx, tiers.length - 1)]; tierIdx += 1; }
    const nth = (usedNames.get(base) || 0) + 1;
    usedNames.set(base, nth);
    out[nth === 1 ? base : `${base}-${nth}`] = v;
  }
  return out;
}

// ============ Structure formatting ============

/** Signature for dedup: structural identity key (excludes accumulated repeat count). */
const sibKey = (n) => JSON.stringify({ ...n, repeat: undefined });

/** Collapse runs of structurally identical siblings into one node + repeat count. */
export function dedupSiblings(kids) {
  const out = [];
  for (const k of kids) {
    const prev = out[out.length - 1];
    if (prev && sibKey(prev) === sibKey(k)) prev.repeat = (prev.repeat || 1) + 1;
    else out.push({ ...k });
  }
  return out;
}

const layoutDesc = (n) => {
  if (!n.lm) return null;
  const parts = [n.lm === 'HORIZONTAL' ? 'horizontal row' : 'vertical stack'];
  if (n.gap) parts.push(`gap ${n.gap}px`);
  if (n.pad) {
    const [t, r, b, l] = n.pad;
    parts.push(t === r && r === b && b === l ? `padding ${t}px` : `padding ${t}/${r}/${b}/${l}px`);
  }
  return parts.join(', ');
};

/**
 * One node → markdown bullet lines (plugin notation):
 * `- **Name** · \`TYPE\` · WxH · horizontal row, gap 8px, padding … · N children`
 * Text nodes append `· "chars"`. Repeats append `· ×N`. Omissions are always
 * explicit: `_…and N more_`.
 */
export function formatTree(node, depth) {
  const indent = '  '.repeat(depth);
  const bits = [`**${node.n}**`, `\`${node.t}\``];
  if (node.w != null) bits.push(`${node.w}×${node.h}`);
  const ld = layoutDesc(node);
  if (ld) bits.push(ld);
  if (node.kids?.length || node.kidCount) bits.push(`${node.kidCount ?? node.kids.length} children`);
  if (node.txt) bits.push(`“${node.txt.chars}”`);
  if (node.mc) bits.push(`instance of ${node.mc}`);
  if (node.repeat) bits.push(`×${node.repeat}`);
  const lines = [`${indent}- ${bits.join(' · ')}`];
  if (node.kids) {
    for (const k of dedupSiblings(node.kids)) lines.push(...formatTree(k, depth + 1));
  }
  if (node.more) lines.push(`${'  '.repeat(depth + 1)}- _…and ${node.more} more_`);
  return lines;
}

/** variantGroupProperties → markdown property/values table. */
export function variantMatrixTable(props) {
  const rows = Object.entries(props || {}).map(([prop, def]) =>
    `| ${prop} | ${(def.values || []).join(', ')} |`);
  if (!rows.length) return '_no variant properties_';
  return ['| Property | Values |', '|---|---|', ...rows].join('\n');
}

/**
 * Reuse handle markdown line for a component census entry. Pure.
 * Returns the line, or null when there is no handle to emit.
 */
export function reuseHandleLine({ key, id } = {}) {
  const parts = [];
  if (key) parts.push(`key \`${key}\``);
  if (id) parts.push(`node \`${id}\``);
  if (!parts.length) return null;
  return `Reuse: import existing — ${parts.join(' · ')}`;
}

// ============ Variables (real Figma variable collections) ============

/**
 * Replace every { alias: <variableId> } in a captured collection list with
 * { alias: <variableName> } so the export is portable (ids are file-local and
 * meaningless after re-import; names are the stable reference). Unknown ids
 * (e.g. aliases to other libraries) are left as the raw id. Pure; returns a
 * new structure, does not mutate the input.
 */
export function resolveAliases(collections = []) {
  const idToName = new Map();
  for (const col of collections)
    for (const v of col.variables || []) idToName.set(v.id, v.name);
  const resolveVal = (val) =>
    val && typeof val === 'object' && 'alias' in val
      ? { alias: idToName.get(val.alias) || val.alias }
      : val;
  return collections.map(col => ({
    name: col.name,
    modes: (col.modes || []).map(m => m.name),
    variables: (col.variables || []).map(v => ({
      name: v.name, type: v.type,
      values: Object.fromEntries(Object.entries(v.values || {}).map(([m, val]) => [m, resolveVal(val)])),
    })),
  }));
}

/** One variable value → a markdown table cell. Pure. */
export function formatVarValue(val) {
  if (val == null) return '—';
  if (typeof val === 'object' && 'alias' in val) return `→ var:${val.alias}`;
  if (typeof val === 'string') return val.startsWith('#') ? `\`${val}\`` : `"${val}"`;
  return String(val);
}

/**
 * Escape an arbitrary string for use inside a single markdown table cell.
 * Variable / collection / mode names and STRING token values come from any
 * design system, so they may contain `|` (column separator) or newlines that
 * would otherwise shatter the table. The JSON token block keeps raw values —
 * this is purely for the human-readable tables. Pure.
 */
export function mdCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Resolved collections → the JSON `variables` block: keyed by collection name,
 * each with its mode list and a { name → {type, values} } variable map.
 * `values` keeps the resolved-alias shape ({ alias: name }) so it roundtrips.
 * Collection names are not unique in Figma, so colliding names are suffixed
 * ` (2)`, ` (3)`… rather than silently overwriting each other.
 */
export function buildVariableTokens(resolvedCollections = []) {
  const out = {};
  for (const col of resolvedCollections) {
    let key = col.name;
    for (let n = 2; key in out; n++) key = `${col.name} (${n})`;
    out[key] = {
      modes: col.modes,
      variables: Object.fromEntries(col.variables.map(v => [v.name, { type: v.type, values: v.values }])),
    };
  }
  return out;
}

// ============ Markdown writer ============

export const ALL_SECTIONS = [
  'identity', 'structure', 'color', 'variables', 'typography', 'spacing',
  'depth', 'components', 'states', 'rules', 'extending', 'tokens',
];

const SECTION_TITLES = {
  identity: 'Identity', structure: 'Structure', color: 'Color', variables: 'Variables',
  typography: 'Typography', spacing: 'Spacing & Layout', depth: 'Depth & Motion',
  components: 'Components', states: 'States', rules: 'Rules',
  extending: 'Extending this system', tokens: 'Machine-readable tokens',
};

/**
 * extraction = { fileName, date, pages: [walker page JSON] }
 * options = { sections?: string[] }  (subset of ALL_SECTIONS, order ignored)
 *
 * Output layout matches the "Design to Markdown" plugin format so
 * parseDesignMd() (Format B: json design-tokens block) reads it unchanged.
 */
export function generateDesignMd(extraction, options = {}) {
  const sections = ALL_SECTIONS.filter(s => !options.sections || options.sections.includes(s));
  const census = buildCensus(extraction.pages);
  const colorNames = assignSemanticNames(census.colors);
  const typeScale = buildTypeScale(census.typography);
  const radiusNames = nameRadii(census.radii);
  const baseUnit = inferBaseUnit(census.spacing);
  const fonts = [...census.fonts];
  const hexToName = Object.fromEntries(Object.entries(colorNames).map(([n, h]) => [h, n]));
  const resolvedVars = resolveAliases(extraction.variables || []);

  const out = [];
  out.push(`# DESIGN.md -- ${extraction.fileName}`, '');
  out.push('<!-- extraction-meta');
  out.push(`source: Figma file "${extraction.fileName}"`);
  out.push(`scope: ${extraction.pages.length} page(s)`);
  out.push(`date: ${extraction.date}`);
  out.push(`nodes-scanned: ${extraction.pages.reduce((a, p) => a + (p.nodeCount || 0), 0)}`);
  out.push(`generator: figma-cli extract`);
  out.push('-->', '');

  let num = 0;
  const header = (key) => { num += 1; out.push(`## ${num}. ${SECTION_TITLES[key]}`, ''); };

  for (const key of sections) {
    if (key === 'identity') {
      header(key);
      out.push(`**In one line:** A design system using ${fonts.join(', ') || 'system fonts'} with ${census.colors.size} unique colors extracted directly from Figma.`, '');
      out.push('**Signature Techniques:**');
      out.push('- Consistent auto-layout spacing system');
      out.push(`- Component library with ${census.componentSets.reduce((a, c) => a + c.variants, 0)} variants across ${census.componentSets.length} component sets`);
      out.push('');
    }
    if (key === 'structure') {
      header(key);
      out.push('High-level composition. Each entry: frame name, type, dimensions, auto-layout.', '');
      for (const page of extraction.pages) {
        out.push(`### Page: ${page.name}`, '');
        if (page.error) { out.push(`<!-- page "${page.name}" skipped: ${page.error} -->`, ''); continue; }
        out.push(`_${page.frames.length} top-level frame(s)_`, '');
        for (const frame of page.frames) out.push(...formatTree(frame, 0));
        out.push('');
      }
    }
    if (key === 'color') {
      header(key);
      out.push('### Palette', '');
      out.push('| Token | Hex | Usage count |', '|---|---|---|');
      const ranked = [...census.colors.entries()].sort((a, b) => b[1] - a[1]);
      for (const [hex, count] of ranked) out.push(`| ${hexToName[hex]} | \`${hex}\` | ${count} |`);
      out.push('');
    }
    if (key === 'variables') {
      header(key);
      if (!resolvedVars.length) {
        out.push('_no local variables found — this file has no variable collections, the palette above is sampled from raw fills_', '');
      } else {
        out.push('Real Figma variable collections — the authoritative tokens (names, modes, values). These come straight from the file, unlike the sampled palette above. `figma-cli import` can recreate them as variables.', '');
        for (const col of resolvedVars) {
          out.push(`### Collection: ${col.name}  ·  ${col.variables.length} variables  ·  modes: ${col.modes.join(', ')}`, '');
          out.push(`| Variable | Type | ${col.modes.map(mdCell).join(' | ')} |`);
          out.push(`|---|---|${col.modes.map(() => '---').join('|')}|`);
          for (const v of col.variables) {
            const cells = col.modes.map(m => mdCell(formatVarValue(v.values[m])));
            out.push(`| ${mdCell(v.name)} | ${v.type} | ${cells.join(' | ')} |`);
          }
          out.push('');
        }
      }
    }
    if (key === 'typography') {
      header(key);
      out.push('### Fonts', '');
      for (const f of fonts) out.push(`- ${f}`);
      out.push('', '### Scale', '');
      out.push('| Token | Family | Size | Weight | Line height |', '|---|---|---|---|---|');
      for (const [name, t] of Object.entries(typeScale)) {
        out.push(`| ${name} | ${t.fontFamily} | ${t.fontSize}px | ${t.fontWeight} | ${t.lineHeight != null ? t.lineHeight + 'px' : 'auto'} |`);
      }
      out.push('');
    }
    if (key === 'spacing') {
      header(key);
      out.push('### Base Unit', '', `${baseUnit}px`, '');
      out.push('### Border Radius', '');
      out.push('| Token | Value |', '|---|---|');
      for (const [name, v] of Object.entries(radiusNames)) out.push(`| ${name} | ${v}px |`);
      out.push('');
    }
    if (key === 'depth') {
      header(key);
      out.push('### Elevation', '');
      const shadows = [...census.shadows.entries()].sort((a, b) => b[1] - a[1]);
      if (!shadows.length) out.push('_no shadow effects found_');
      for (const [json, count] of shadows) {
        const e = JSON.parse(json);
        if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
          out.push(`- ${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${e.color} @ ${Math.round(e.a * 100)}% (used ${count}×)`);
        } else {
          out.push(`- ${e.type} blur ${e.blur}px (used ${count}×)`);
        }
      }
      out.push('');
    }
    if (key === 'components') {
      header(key);
      if (!census.componentSets.length) out.push('_no component sets found_', '');
      for (const cs of census.componentSets) {
        out.push(`### ${cs.name}`, '');
        out.push(`Page: ${cs.page} · ${cs.variants} variants`, '');
        const reuse = reuseHandleLine({ key: cs.key, id: cs.id });
        if (reuse) out.push(reuse, '');
        out.push(variantMatrixTable(cs.props), '');
        if (cs.sample) {
          out.push('Sample variant structure:', '');
          out.push(...formatTree(cs.sample, 0), '');
        }
      }
    }
    if (key === 'states') {
      header(key);
      out.push('State tokens should be derived from the base palette above. Recommended mappings:', '');
      out.push('| State | Treatment |', '|-------|-----------|');
      out.push('| Hover | Lighten/darken accent by 10% |');
      out.push('| Focus | 2px ring using accent color with 30% opacity |');
      out.push('| Disabled | 40% opacity, no pointer events |');
      out.push('| Error | Use danger color for border and text |', '');
    }
    if (key === 'rules') {
      header(key);
      out.push('### Do', '');
      out.push(`- Use the ${baseUnit}px base unit for all spacing decisions`);
      const accent = colorNames['accent'];
      if (accent) out.push(`- Use \`${accent}\` (accent) as the primary accent color`);
      out.push('- Bind colors to the tokens below instead of hardcoding hex values', '');
      out.push("### Don't", '');
      out.push('- Introduce new colors without adding them to the palette');
      out.push('- Mix corner radii outside the radius scale', '');
    }
    if (key === 'extending') {
      header(key);
      out.push('### How to reuse this DESIGN.md', '');
      out.push('Import into Figma with `figma-cli import <this file>` — colors, radii and typography become variables.', '');
      out.push('### When to add a new token vs reuse', '');
      out.push('Reuse the closest existing token; add a new one only when a new semantic role appears.', '');
    }
    if (key === 'tokens') {
      header(key);
      out.push('The block below is the canonical token map. It mirrors the tables above but is unambiguous and parseable.', '');
      const tokens = {
        $schema: 'design-tokens.v1',
        meta: { source: extraction.fileName, generated: extraction.date },
        color: colorNames,
        typography: typeScale,
        spacing: { 'base-unit': baseUnit },
        radius: Object.fromEntries(Object.entries(radiusNames).map(([n, v]) => [n, `${v}px`])),
        shadow: {},
        fonts,
        ...(resolvedVars.length ? { variables: buildVariableTokens(resolvedVars) } : {}),
      };
      let i = 0;
      for (const [json] of [...census.shadows.entries()].sort((a, b) => b[1] - a[1])) {
        const e = JSON.parse(json);
        if (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW') continue;
        i += 1;
        tokens.shadow[`shadow-${i}`] = `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${e.color}${e.a < 1 ? Math.round(e.a * 255).toString(16).padStart(2, '0') : ''}`;
      }
      out.push('```json design-tokens');
      out.push(JSON.stringify(tokens, null, 2));
      out.push('```', '');
    }
  }
  return out.join('\n');
}

/** Full uncompressed tree for one page (used by --split). */
export function generatePageStructureMd(page) {
  const out = [`# Structure: ${page.name}`, ''];
  if (page.error) { out.push(`_page skipped: ${page.error}_`); return out.join('\n'); }
  for (const frame of page.frames) out.push(...formatTree(frame, 0));
  return out.join('\n');
}

/** ~3.8 chars per token is a good markdown estimate. */
const CHARS_PER_TOKEN = 3.8;

/**
 * Estimated LLM token cost of the Structure section for these pages.
 * Used by the extract command to auto-split oversized files: above the
 * threshold the structure trees move to DESIGN-structure/ so the main
 * DESIGN.md stays loadable in one AI context.
 */
export function estimateStructureTokens(pages) {
  let chars = 0;
  for (const page of pages) {
    if (page.error) continue;
    for (const frame of page.frames || []) {
      chars += formatTree(frame, 0).join('\n').length + 1;
    }
  }
  return Math.round(chars / CHARS_PER_TOKEN);
}
