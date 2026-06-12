# `figma-cli extract` (DESIGN.md exporter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `figma-cli extract [output.md]` command that walks every page of the open Figma file (one daemon eval per page) and writes a plugin-compatible, roundtrip-safe DESIGN.md — with no truncation, variant matrices for component sets, and `--sections/--pages/--selection/--split` flags.

**Architecture:** Three units. (1) A walker-code generator that produces the JS string evaluated inside Figma per page, returning compact node JSON. (2) A pure Node-side aggregator (`src/design-extract.js`) that builds color/typography/spacing/radius/shadow censuses, semantic color names, variant matrices, and sibling dedup. (3) A markdown writer in the same module emitting the 11-section format that `src/design-md.js#parseDesignMd` already parses. The command module (`src/commands/extract.js`) orchestrates: list pages → walk each → aggregate → write file(s).

**Tech Stack:** Node 18+ ESM, commander (via shared `program` from `src/lib/cli-core.js`), `fastEval` for daemon evals, `ora`/`chalk` for UX, `node --test` for tests.

**Spec:** `docs/superpowers/specs/2026-06-12-design-extract-design.md`

---

## Conventions you must know (read before Task 1)

- This repo is **ESM** (`"type": "module"`). All imports need explicit `.js` extensions.
- Command modules in `src/commands/*.js` are **side-effect imports**: they import the shared `program` from `../lib/cli-core.js`, register commands on it, and get pulled in by `src/index.js` via `import './commands/<name>.js';`.
- Code evaluated inside Figma must be an **explicit async IIFE** `(async () => { ... })()` and should `return JSON.stringify(...)` (the daemon returns the value; CDP/plugin modes both handle a returned string). The shell escapes are irrelevant here because we pass code via `fastEval()` from Node, never through a shell.
- `fastEval(code)` (exported from `src/lib/cli-core.js`) → returns the eval result, daemon-first with direct-connection fallback. `checkConnection()` must be called once at the start of every command action.
- Tests: `node --test tests/*.test.js` (`npm test`). Use `node:test` + `node:assert/strict`. Pure functions are tested by importing the module directly — no Figma needed.
- The walker node JSON shape (defined in Task 1, used everywhere):

```
{ t: 'FRAME',            // node type
  n: 'Card',             // name
  w: 320, h: 200,        // rounded px
  lm: 'VERTICAL',        // layoutMode if not NONE
  gap: 8,                // itemSpacing
  pad: [t, r, b, l],     // padding
  fills: ['#ffffff'],    // solid paints as hex ('#rrggbb' or '#rrggbb@80' w/ opacity %), others as type string
  strokes: ['#d0d7de'], sw: 1,
  r: 8,                  // cornerRadius (number) or [tl,tr,br,bl] when mixed
  fx: [{ type: 'DROP_SHADOW', x, y, blur, spread, color: '#000000', a: 0.2 }],
  txt: { chars, font, style, size, lh, ls },   // TEXT only
  vp: { Size: { values: ['Small','Large'] } }, // COMPONENT_SET only (variantGroupProperties)
  kidCount: 116,         // COMPONENT_SET only
  mc: 'Button/Primary',  // INSTANCE only (name); instances are NOT expanded
  kids: [...],           // children
  more: 5 }              // children omitted at depth cap (count, never silent)
```

---

### Task 1: Walker code generator (`walkerCode`) in `src/design-extract.js`

**Files:**
- Create: `src/design-extract.js`
- Test: `tests/design-extract.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/design-extract.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkerCode, listPagesCode } from '../src/design-extract.js';

test('walkerCode produces syntactically valid JS', () => {
  const code = walkerCode('123:45');
  // Throws SyntaxError if invalid. Wrap in a function shell because the
  // code is an async IIFE expression.
  assert.doesNotThrow(() => new Function(`return ${code}`));
});

test('walkerCode embeds page id and options', () => {
  const code = walkerCode('123:45', { maxDepth: 5, textLimit: 40 });
  assert.match(code, /"123:45"/);
  assert.match(code, /MAX_DEPTH = 5/);
  assert.match(code, /TEXT_LIMIT = 40/);
});

test('walkerCode defaults: depth 8, text 80', () => {
  const code = walkerCode('1:1');
  assert.match(code, /MAX_DEPTH = 8/);
  assert.match(code, /TEXT_LIMIT = 80/);
});

test('listPagesCode is valid JS', () => {
  assert.doesNotThrow(() => new Function(`return ${listPagesCode()}`));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/design-extract.test.js`
Expected: FAIL — `Cannot find module '../src/design-extract.js'`

- [ ] **Step 3: Implement `walkerCode` and `listPagesCode`**

Create `src/design-extract.js`:

```js
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
    let visited = 0;
    const count = (n) => { visited++; if ('children' in n) n.children.forEach(count); };
    count(page);
    return JSON.stringify({ id: page.id, name: page.name, nodeCount: visited, frames: page.children.map(c => walk(c, 0)) });
  })()`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/design-extract.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/design-extract.js tests/design-extract.test.js
git commit -m "feat(extract): walker code generator for per-page Figma eval"
```

---

### Task 2: Color census + semantic namer

**Files:**
- Modify: `src/design-extract.js` (append)
- Test: `tests/design-extract.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/design-extract.test.js`:

```js
import { buildCensus, assignSemanticNames } from '../src/design-extract.js';

const FIXTURE_PAGES = [
  {
    id: '1:1', name: 'Buttons', nodeCount: 10,
    frames: [
      { t: 'FRAME', n: 'Row', w: 400, h: 40, lm: 'HORIZONTAL', gap: 8, fills: ['#ffffff'], kids: [
        { t: 'COMPONENT', n: 'Primary', w: 71, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12], fills: ['#1f883d'], r: 6, kids: [
          { t: 'TEXT', n: 'Button', w: 47, h: 20, txt: { chars: 'Button', font: 'Inter', style: 'Semi Bold', size: 14, lh: 20 }, fills: ['#ffffff'] },
        ] },
        { t: 'COMPONENT', n: 'Default', w: 71, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12], fills: ['#f6f8fa'], strokes: ['#d0d7de'], sw: 1, r: 6, kids: [
          { t: 'TEXT', n: 'Button', w: 47, h: 20, txt: { chars: 'Button', font: 'Inter', style: 'Semi Bold', size: 14, lh: 20 }, fills: ['#1f2328'] },
        ] },
      ] },
    ],
  },
];

test('buildCensus counts colors from fills and strokes', () => {
  const census = buildCensus(FIXTURE_PAGES);
  assert.equal(census.colors.get('#ffffff'), 2);   // frame fill + text fill
  assert.equal(census.colors.get('#1f883d'), 1);
  assert.equal(census.colors.get('#d0d7de'), 1);   // stroke
});

test('buildCensus strips opacity suffix from paint strings', () => {
  const census = buildCensus([{ id: 'x', name: 'P', nodeCount: 1, frames: [
    { t: 'FRAME', n: 'F', w: 10, h: 10, fills: ['#000000@50'] },
  ] }]);
  assert.equal(census.colors.get('#000000'), 1);
});

test('assignSemanticNames classifies by lightness and chroma', () => {
  const colors = new Map([
    ['#ffffff', 50],  // near-white → background
    ['#1f2328', 40],  // dark, low sat → text-primary
    ['#0969da', 30],  // chromatic → accent
    ['#d0d7de', 20],  // light gray → border
    ['#59636e', 10],  // mid gray → text-*
  ]);
  const named = assignSemanticNames(colors);
  assert.equal(named['background'], '#ffffff');
  assert.equal(named['text-primary'], '#1f2328');
  assert.equal(named['accent'], '#0969da');
  assert.ok(Object.values(named).includes('#d0d7de'));
  assert.equal(Object.keys(named).length, 5);
});

test('assignSemanticNames suffixes duplicates with -alt, -3, -4', () => {
  const colors = new Map([
    ['#0969da', 30], ['#d1242f', 20], ['#8250df', 10],
  ]);
  const named = assignSemanticNames(colors);
  assert.equal(named['accent'], '#0969da');
  assert.equal(named['accent-alt'], '#d1242f');
  assert.equal(named['accent-3'], '#8250df');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/design-extract.test.js`
Expected: FAIL — `buildCensus` is not exported

- [ ] **Step 3: Implement `buildCensus` and `assignSemanticNames`**

Append to `src/design-extract.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/design-extract.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/design-extract.js tests/design-extract.test.js
git commit -m "feat(extract): census builder and semantic color namer"
```

---

### Task 3: Typography scale, base-unit inference, radius/shadow naming

**Files:**
- Modify: `src/design-extract.js` (append)
- Test: `tests/design-extract.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/design-extract.test.js`:

```js
import { buildTypeScale, inferBaseUnit, nameRadii } from '../src/design-extract.js';

test('buildTypeScale names styles by size rank (display > h1 > … > body > caption)', () => {
  const typo = new Map([
    ['Inter|Bold|40|48|', 5],
    ['Inter|Semi Bold|24|32|', 10],
    ['Inter|Regular|14|20|', 100],
    ['Inter|Regular|12|16|', 30],
  ]);
  const scale = buildTypeScale(typo);
  const names = Object.keys(scale);
  assert.ok(names.includes('display'));
  assert.ok(names.includes('body'));
  assert.ok(names.includes('caption'));
  assert.equal(scale['body'].fontSize, 14);
  assert.equal(scale['body'].fontFamily, 'Inter');
  assert.equal(scale['body'].fontWeight, 400);   // 'Regular' → 400
  assert.equal(scale['display'].fontWeight, 700); // 'Bold' → 700
});

test('inferBaseUnit picks the dominant grid from spacing counts', () => {
  assert.equal(inferBaseUnit(new Map([[8, 50], [16, 40], [24, 20], [4, 10]])), 4);
  assert.equal(inferBaseUnit(new Map([[8, 50], [16, 40], [32, 10]])), 8);
  assert.equal(inferBaseUnit(new Map()), 8); // sensible default
});

test('nameRadii produces sm/md/lg names sorted by value', () => {
  const named = nameRadii(new Map([[2, 50], [6, 80], [12, 20], [9999, 5]]));
  assert.equal(named['radius-sm'], 2);
  assert.equal(named['radius-md'], 6);
  assert.equal(named['radius-lg'], 12);
  assert.equal(named['radius-full'], 9999);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/design-extract.test.js`
Expected: FAIL — `buildTypeScale` is not exported

- [ ] **Step 3: Implement the three functions**

Append to `src/design-extract.js`:

```js
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
  let weighted = { 2: 0, 4: 0, 8: 0 };
  for (const [value, count] of spacing) {
    for (const unit of [8, 4, 2]) {
      if (value % unit === 0) { weighted[unit] += count; break; }
    }
  }
  if (weighted[8] >= weighted[4] && weighted[8] >= weighted[2]) return 8;
  if (weighted[4] >= weighted[2]) return 4;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/design-extract.test.js`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/design-extract.js tests/design-extract.test.js
git commit -m "feat(extract): type scale, base unit inference, radius naming"
```

---

### Task 4: Tree formatter, sibling dedup, variant matrix

**Files:**
- Modify: `src/design-extract.js` (append)
- Test: `tests/design-extract.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/design-extract.test.js`:

```js
import { formatTree, dedupSiblings, variantMatrixTable } from '../src/design-extract.js';

test('formatTree emits the plugin tree notation', () => {
  const node = {
    t: 'FRAME', n: 'Button', w: 71, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12],
    kids: [{ t: 'TEXT', n: 'Label', w: 47, h: 20, txt: { chars: 'Button' } }],
  };
  const lines = formatTree(node, 0);
  assert.match(lines[0], /\*\*Button\*\* · `FRAME` · 71×32 · horizontal row, gap 8px, padding 6\/12\/6\/12px · 1 children/);
  assert.match(lines[1], /^ {2}- \*\*Label\*\* · `TEXT` · 47×20 · “Button”/);
});

test('formatTree shows explicit omission counts (never silent)', () => {
  const node = { t: 'FRAME', n: 'Deep', w: 10, h: 10, more: 7 };
  const lines = formatTree(node, 0);
  assert.match(lines.join('\n'), /…and 7 more/);
});

test('dedupSiblings collapses identical siblings to one entry with ×N', () => {
  const btn = (name) => ({ t: 'INSTANCE', n: name, w: 71, h: 32, mc: 'Button' });
  const kids = [btn('Button'), btn('Button'), btn('Button'), btn('Other')];
  const deduped = dedupSiblings(kids);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].repeat, 3);
  assert.equal(deduped[1].n, 'Other');
});

test('variantMatrixTable renders a property/values table', () => {
  const md = variantMatrixTable({ trigger: { values: ['icon-button', 'button'] }, open: { values: ['true', 'false'] } });
  assert.match(md, /\| trigger \| icon-button, button \|/);
  assert.match(md, /\| open \| true, false \|/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/design-extract.test.js`
Expected: FAIL — `formatTree` is not exported

- [ ] **Step 3: Implement the three functions**

Append to `src/design-extract.js`:

```js
// ============ Structure formatting ============

/** Signature for dedup: everything except the name. */
const sibKey = (n) => JSON.stringify({ ...n, n: undefined });

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
 * Text nodes append `· “chars”`. Repeats append `· ×N`. Omissions are always
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/design-extract.test.js`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add src/design-extract.js tests/design-extract.test.js
git commit -m "feat(extract): tree formatter, sibling dedup, variant matrices"
```

---

### Task 5: Markdown writer + roundtrip with `parseDesignMd`

**Files:**
- Modify: `src/design-extract.js` (append)
- Test: `tests/design-extract.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/design-extract.test.js`:

```js
import { generateDesignMd, ALL_SECTIONS } from '../src/design-extract.js';
import { parseDesignMd } from '../src/design-md.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTRACTION = {
  fileName: 'Test File',
  date: '2026-06-12',
  pages: FIXTURE_PAGES,
};

test('generateDesignMd emits all 11 sections by default', () => {
  const md = generateDesignMd(EXTRACTION);
  for (const [i, title] of [
    [1, 'Identity'], [2, 'Structure'], [3, 'Color'], [4, 'Typography'],
    [5, 'Spacing & Layout'], [6, 'Depth & Motion'], [7, 'Components'],
    [8, 'States'], [9, 'Rules'], [10, 'Extending this system'],
    [11, 'Machine-readable tokens'],
  ]) {
    assert.match(md, new RegExp(`^## ${i}\\. ${title.replace(/[&]/g, '\\$&')}`, 'm'), `missing section ${i} ${title}`);
  }
});

test('generateDesignMd respects --sections selection and renumbers', () => {
  const md = generateDesignMd(EXTRACTION, { sections: ['color', 'tokens'] });
  assert.match(md, /^## 1\. Color/m);
  assert.match(md, /^## 2\. Machine-readable tokens/m);
  assert.doesNotMatch(md, /## \d+\. Structure/);
});

test('roundtrip: parseDesignMd reads generateDesignMd output', () => {
  const md = generateDesignMd(EXTRACTION);
  const dir = mkdtempSync(join(tmpdir(), 'extract-test-'));
  const file = join(dir, 'DESIGN.md');
  writeFileSync(file, md);
  const parsed = parseDesignMd(file);
  assert.equal(parsed.meta.source, 'Test File');
  // every census color appears in the parsed token map
  const parsedColors = Object.values(parsed.tokens.color);
  assert.ok(parsedColors.includes('#ffffff'));
  assert.ok(parsedColors.includes('#1f883d'));
  // typography roundtrips with family + size
  const tNames = Object.keys(parsed.tokens.typography);
  assert.ok(tNames.length >= 1);
});

test('structure section contains untruncated page trees', () => {
  const md = generateDesignMd(EXTRACTION);
  assert.match(md, /### Page: Buttons/);
  assert.match(md, /\*\*Primary\*\* · `COMPONENT` · 71×32/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/design-extract.test.js`
Expected: FAIL — `generateDesignMd` is not exported

- [ ] **Step 3: Implement `generateDesignMd`**

Append to `src/design-extract.js`:

```js
// ============ Markdown writer ============

export const ALL_SECTIONS = [
  'identity', 'structure', 'color', 'typography', 'spacing',
  'depth', 'components', 'states', 'rules', 'extending', 'tokens',
];

const SECTION_TITLES = {
  identity: 'Identity', structure: 'Structure', color: 'Color',
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/design-extract.test.js`
Expected: PASS (20 tests). The roundtrip test proves `parseDesignMd` reads our output (Format B path: `json design-tokens` block).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all suites PASS

- [ ] **Step 6: Commit**

```bash
git add src/design-extract.js tests/design-extract.test.js
git commit -m "feat(extract): markdown writer with parseDesignMd roundtrip guarantee"
```

---

### Task 6: The `extract` command

**Files:**
- Create: `src/commands/extract.js`
- Modify: `src/index.js` (add one import line after `import './commands/misc.js';`)

No unit test for the command itself (it needs a live Figma); correctness is covered by Task 5's pure-function tests plus the Task 8 real-world check. Keep the command thin: flag parsing, eval loop, file writing.

- [ ] **Step 1: Implement the command module**

Create `src/commands/extract.js`:

```js
// Command: extract — scan the open Figma file and write a DESIGN.md
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { program, checkConnection, fastEval } from '../lib/cli-core.js';
import {
  listPagesCode, walkerCode, generateDesignMd, generatePageStructureMd, ALL_SECTIONS,
} from '../design-extract.js';

const DEPTH_FLOOR = 3;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';

program
  .command('extract [output]')
  .description('Scan the open Figma file (all pages) and write a DESIGN.md — tokens, structure, component variant matrices. Roundtrips with `figma-cli import`.')
  .option('--sections <list>', `comma list of sections (${ALL_SECTIONS.join(',')})`)
  .option('--pages <list>', 'only pages whose name matches one of these (comma list, case-insensitive substring)')
  .option('--selection', 'only the currently selected nodes (overrides --pages)')
  .option('--split', 'additionally write full per-page trees to DESIGN-structure/')
  .action(async (output, options) => {
    await checkConnection();
    const outPath = resolve(output || 'DESIGN.md');

    let sections;
    if (options.sections) {
      sections = options.sections.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const bad = sections.filter(s => !ALL_SECTIONS.includes(s));
      if (bad.length) {
        console.error(chalk.red(`Unknown section(s): ${bad.join(', ')}`));
        console.error(chalk.gray(`Valid: ${ALL_SECTIONS.join(', ')}`));
        process.exit(1);
      }
    }

    const spinner = ora('Reading file info...').start();
    try {
      let pages;
      if (options.selection) {
        // Wrap the selection in a synthetic single "page".
        const sel = JSON.parse(await fastEval(`(async () => {
          const sel = figma.currentPage.selection;
          return JSON.stringify({ ids: sel.map(n => n.id), pageId: figma.currentPage.id, pageName: figma.currentPage.name });
        })()`));
        if (!sel.ids.length) {
          spinner.fail('Nothing selected in Figma.');
          process.exit(1);
        }
        pages = [{ id: sel.pageId, name: sel.pageName, selectionIds: sel.ids }];
      } else {
        pages = JSON.parse(await fastEval(listPagesCode()));
        if (options.pages) {
          const filters = options.pages.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
          pages = pages.filter(p => filters.some(f => p.name.toLowerCase().includes(f)));
          if (!pages.length) {
            spinner.fail(`No pages match "${options.pages}".`);
            process.exit(1);
          }
        }
      }

      const fileName = JSON.parse(await fastEval(
        `(async () => JSON.stringify(figma.root.name))()`
      ));

      const results = [];
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        spinner.text = `Page ${i + 1}/${pages.length}: ${page.name}…`;
        let depth = 8;
        let result = null;
        while (depth >= DEPTH_FLOOR) {
          try {
            const code = page.selectionIds
              ? walkerCode(page.id, { maxDepth: depth }).replace(
                  'page.children.map',
                  `page.children.filter(c => ${JSON.stringify(page.selectionIds)}.includes(c.id)).map`)
              : walkerCode(page.id, { maxDepth: depth });
            result = JSON.parse(await fastEval(code));
            if (depth < 8) result.reducedDepth = depth;
            break;
          } catch (e) {
            // Payload-size / timeout errors → retry shallower. Anything else → skip page.
            if (/payload|too large|timeout/i.test(e.message) && depth > DEPTH_FLOOR) { depth -= 2; continue; }
            result = { id: page.id, name: page.name, nodeCount: 0, frames: [], error: e.message };
            break;
          }
        }
        if (!result) result = { id: page.id, name: page.name, nodeCount: 0, frames: [], error: `exceeded payload limit even at depth ${DEPTH_FLOOR}` };
        results.push(result);
      }

      spinner.text = 'Generating DESIGN.md…';
      const extraction = {
        fileName,
        date: new Date().toISOString().slice(0, 10),
        pages: results,
      };
      const md = generateDesignMd(extraction, { sections });
      writeFileSync(outPath, md);

      const written = [outPath];
      if (options.split) {
        const splitDir = join(dirname(outPath), 'DESIGN-structure');
        mkdirSync(splitDir, { recursive: true });
        for (const page of results) {
          const f = join(splitDir, `${slug(page.name)}.md`);
          writeFileSync(f, generatePageStructureMd(page));
          written.push(f);
        }
      }

      const failed = results.filter(r => r.error);
      const totalNodes = results.reduce((a, p) => a + (p.nodeCount || 0), 0);
      spinner.succeed(`Extracted ${results.length} page(s), ${totalNodes} nodes → ${outPath}`);
      if (options.split) console.log(chalk.gray(`  + ${results.length} structure file(s) in DESIGN-structure/`));
      if (failed.length) {
        console.log(chalk.yellow(`  ⚠ ${failed.length} page(s) skipped:`));
        for (const f of failed) console.log(chalk.yellow(`    - ${f.name}: ${f.error}`));
      }
      console.log(chalk.gray(`  Re-import anytime: figma-cli import ${output || 'DESIGN.md'}`));
    } catch (e) {
      spinner.fail(`Extraction failed: ${e.message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Register the module in `src/index.js`**

In `src/index.js`, after the line `import './commands/misc.js';` add:

```js
import './commands/extract.js';
```

- [ ] **Step 3: Smoke-test registration (no Figma needed)**

Run: `node src/index.js extract --help`
Expected: help text showing `[output]`, `--sections`, `--pages`, `--selection`, `--split`. No connection attempt (help short-circuits the action).

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/extract.js src/index.js
git commit -m "feat(extract): figma-cli extract command with scope, sections and split flags"
```

---

### Task 7: Docs — CLAUDE.md, COMMANDS.md

**Files:**
- Modify: `CLAUDE.md` (Quick Reference table + new section)
- Modify: `docs/COMMANDS.md` (add command reference entry)

- [ ] **Step 1: Add Quick Reference rows to `CLAUDE.md`**

In the Quick Reference table (after the `gradient mesh` row), add:

```markdown
| "export the design system as markdown" / "create a DESIGN.md" | `figma-cli extract` |
| "export only the tokens" | `figma-cli extract --sections tokens` |
| "extract/document the X page" | `figma-cli extract --pages "X"` |
| "extract what I selected" | `figma-cli extract --selection` |
```

- [ ] **Step 2: Add a guidance block to `CLAUDE.md`**

After the "## Design Tokens" section, add:

```markdown
## DESIGN.md Export (extract)

`figma-cli extract [output.md]` scans the open file and writes a DESIGN.md
(same 11-section format the importer reads — full roundtrip).

- Default = ALL pages, ALL sections. Use `--pages "Button,ActionMenu"` (substring
  match) or `--selection` to scope; `--sections tokens` for tokens-only.
- `--split` additionally writes full per-page trees to `DESIGN-structure/`.
- Users speak naturally ("export the design system as markdown") — map intent
  to flags, never make them memorize commands.
- After extraction, summarize what was captured (pages, token counts, skipped
  pages). Don't dump the file contents into chat.
- Re-import with `figma-cli import <file>`.
```

- [ ] **Step 3: Add the command to `docs/COMMANDS.md`**

Follow the existing entry format in that file (check its layout first); document the command, all four flags, the default output path, and the roundtrip note.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/COMMANDS.md
git commit -m "docs(extract): natural-language mappings and command reference"
```

---

### Task 8: Real-world verification against the open Primer file

Figma Desktop must be running with the Primer Web (Community) file open and `figma-cli connect` done. This task validates against the spec's acceptance criteria.

- [ ] **Step 1: Full extraction**

Run: `node src/index.js extract /tmp/DESIGN-primer-cli.md`
Expected: spinner walks all ~67 pages, succeeds, reports node count. Some pages may report reduced depth — fine. Zero pages skipped is the goal; investigate any skips.

- [ ] **Step 2: Verify no truncation (the plugin's failure mode)**

Run: `grep -c "### Page:" /tmp/DESIGN-primer-cli.md`
Expected: ~67 (every page present — the plugin only managed 10).

- [ ] **Step 3: Verify the ActionMenu variant matrix**

Run: `grep -A8 "^### ActionMenu" /tmp/DESIGN-primer-cli.md | head -20`
Expected: a property table containing `trigger`, `open`, `align` rows (matching the known Primer variant axes).

- [ ] **Step 4: Verify roundtrip with the real importer**

Run: `node src/index.js import /tmp/DESIGN-primer-cli.md`
Expected: imports without parse errors, reports color/radius/typography counts consistent with the extraction summary.

- [ ] **Step 5: Scoped + split + sections flags**

Run:
```bash
node src/index.js extract /tmp/D-scoped.md --pages "Avatars"
grep -c "### Page:" /tmp/D-scoped.md          # expected: 1
node src/index.js extract /tmp/D-tokens.md --sections tokens
grep -c "^## " /tmp/D-tokens.md               # expected: 1
node src/index.js extract /tmp/D-split.md --split
ls /tmp/DESIGN-structure/ | head              # expected: one .md per page
```

- [ ] **Step 6: Fix anything found, then commit**

```bash
git add -A
git commit -m "fix(extract): real-world findings from Primer Web extraction"
```

(Skip the commit if nothing needed fixing.)

---

## Self-review notes

- Spec coverage: walker-per-page (T1), censuses + naming (T2/T3), variant matrices + dedup + explicit omission markers (T4), 11 plugin-compatible sections + roundtrip + `--split` writer (T5), command with `--sections/--pages/--selection/--split`, page-failure tolerance, depth-reduction retry, progress UX (T6), CLAUDE.md natural-language mappings (T7), Primer acceptance test (T8). REST-API mode, image export, diffing: out of scope per spec.
- The `--selection` walker reuses `walkerCode` with a filter injected on the single `page.children.map` call site — brittle if Task 1's template changes; if the string replace ever fails to match, the command falls back to walking the whole page (acceptable degradation, noted here deliberately).
- Type consistency: walker JSON keys (`t,n,w,h,lm,gap,pad,fills,strokes,sw,r,fx,txt,vp,kidCount,mc,kids,more`) defined once in the conventions block; aggregator and formatter read exactly these.
