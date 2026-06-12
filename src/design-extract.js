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
        if (n.lineHeight !== figma.mixed && n.lineHeight && n.lineHeight.unit !== 'AUTO') o.txt.lh = n.lineHeight.value;
        if (n.letterSpacing !== figma.mixed && n.letterSpacing && n.letterSpacing.value) o.txt.ls = n.letterSpacing.value;
      }
      if (n.type === 'COMPONENT_SET') {
        try { o.vp = n.variantGroupProperties; } catch (e) {}
        o.kidCount = n.children.length;
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
      census.componentSets.push({ name: n.n, page: pageName, props: n.vp || {}, variants: n.kidCount || 0, sample: n.kids?.[0] });
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
