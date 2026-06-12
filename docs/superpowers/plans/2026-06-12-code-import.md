# Code & Storybook Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `figma-cli import <source>` accepts Tailwind configs, CSS custom-property files, W3C design-tokens JSON and Storybook (URL or static build) — converting each to the existing DESIGN.md interchange format and reusing the existing variable-creation pipeline.

**Architecture:** New `src/code-import/` module family. Each parser is a pure function `parse*(content|source) → { tokens, meta }` in the normalized shape `parseDesignMd` returns. A dispatcher `convert(source, {type})` detects the source kind, parses, and renders an equivalent DESIGN.md string (Format B with `json design-tokens` block). The `import` command (src/commands/setup.js) gains detection branches: convert → write DESIGN.md to a temp file (or `--save` path) → forward to the existing `tokens import-design-md` machinery. Storybook with zero tokens skips variable creation and just saves/prints context.

**Tech Stack:** Node 18+ ESM, no new dependencies (regex CSS parsing, native fetch, child_process for Tailwind configs). Tests: `node --test` with fixture files in `tests/fixtures/code-import/`.

**Spec:** `docs/superpowers/specs/2026-06-12-code-import-design.md`

---

## Conventions (read before any task)

- ESM repo, explicit `.js` extensions in imports.
- Normalized token shape (what every parser returns):
  ```
  { tokens: { color: {name: '#hex'}, typography: {name: {fontFamily, fontSize, fontWeight, lineHeight?, letterSpacing?}},
              radius: {name: number}, spacing: {name: number}, shadow: {}, fonts: [..] },
    meta:   { source: string, components?: [{name, variants: [..], category?}] } }
  ```
- `parseDesignMd` (src/design-md.js) reads Format B: needs `# DESIGN.md -- <name>` h1, `**In one line:**` line, `## N. Machine-readable tokens` section with a ```` ```json design-tokens ```` block. Radius values in the JSON block are strings like `"6px"` (stripPx in the importer) or numbers — write `"<n>px"` strings for consistency with extract's writer.
- Tests live in `tests/code-import.test.js`; fixtures in `tests/fixtures/code-import/`. Run: `node --test tests/code-import.test.js`.
- Commit after each task (live verification happens in the final task BEFORE pushing anywhere; committing locally is fine).

---

### Task 1: W3C design-tokens parser

**Files:**
- Create: `src/code-import/w3c-tokens.js`
- Create: `tests/fixtures/code-import/tokens-style-dictionary.json`
- Create: `tests/code-import.test.js`

- [ ] **Step 1: Create the fixture** `tests/fixtures/code-import/tokens-style-dictionary.json`:

```json
{
  "color": {
    "brand": {
      "primary": { "$value": "#0969da", "$type": "color" },
      "secondary": { "value": "#6639ba" }
    },
    "text": {
      "default": { "$value": "{color.brand.primary}" }
    }
  },
  "radius": {
    "md": { "$value": "6px", "$type": "dimension" },
    "lg": { "$value": "0.75rem" }
  },
  "spacing": {
    "sm": { "$value": "8px" }
  },
  "font": {
    "body": { "$value": { "fontFamily": "Inter", "fontSize": "14px", "fontWeight": 400, "lineHeight": "20px" }, "$type": "typography" }
  }
}
```

- [ ] **Step 2: Write failing tests** (`tests/code-import.test.js`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseW3cTokens } from '../src/code-import/w3c-tokens.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'code-import');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');

test('w3c: extracts colors with $value and legacy value, drops group prefix', () => {
  const { tokens } = parseW3cTokens(fixture('tokens-style-dictionary.json'));
  assert.equal(tokens.color['brand-primary'], '#0969da');
  assert.equal(tokens.color['brand-secondary'], '#6639ba');
});

test('w3c: resolves {alias} references', () => {
  const { tokens } = parseW3cTokens(fixture('tokens-style-dictionary.json'));
  assert.equal(tokens.color['text-default'], '#0969da');
});

test('w3c: dimensions become numbers (px direct, rem ×16)', () => {
  const { tokens } = parseW3cTokens(fixture('tokens-style-dictionary.json'));
  assert.equal(tokens.radius['radius-md'], 6);
  assert.equal(tokens.radius['radius-lg'], 12);
  assert.equal(tokens.spacing['spacing-sm'], 8);
});

test('w3c: typography tokens keep the full shape', () => {
  const { tokens } = parseW3cTokens(fixture('tokens-style-dictionary.json'));
  assert.deepEqual(tokens.typography['font-body'], { fontFamily: 'Inter', fontSize: 14, fontWeight: 400, lineHeight: 20 });
  assert.ok(tokens.fonts.includes('Inter'));
});

test('w3c: cyclic aliases throw a clear error', () => {
  const cyclic = JSON.stringify({ a: { $value: '{b}' }, b: { $value: '{a}' } });
  assert.throws(() => parseW3cTokens(cyclic), /cycl|circular/i);
});

test('w3c: invalid JSON throws with context', () => {
  assert.throws(() => parseW3cTokens('not json'), /JSON/);
});
```

- [ ] **Step 3: Run to verify FAIL** (module not found), then implement `src/code-import/w3c-tokens.js`:

```js
/**
 * W3C design-tokens (Style Dictionary / Tokens Studio) parser.
 * A token is any object carrying `$value` (or legacy `value`). Names are the
 * group path joined with '-'; a leading group named color/colors is dropped
 * (so color.brand.primary → brand-primary). Dimension buckets are inferred
 * from the path (radius/spacing) — everything else dimensional is ignored.
 */
const toPx = (v) => {
  if (typeof v === 'number') return v;
  const m = String(v).match(/^([\d.]+)(px|rem)?$/);
  if (!m) return null;
  return m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
};

const isColor = (v) => typeof v === 'string' && /^(#|rgb|hsl)/.test(v.trim());

export function parseW3cTokens(jsonText) {
  let doc;
  try { doc = JSON.parse(jsonText); }
  catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }

  // 1) flatten: path → raw token
  const flat = new Map();
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if ('$value' in node || 'value' in node) {
      flat.set(path.join('.'), { value: node.$value ?? node.value, type: node.$type ?? node.type });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      walk(v, [...path, k]);
    }
  };
  walk(doc, []);

  // 2) resolve {alias} references (with cycle detection)
  const resolve = (value, seen) => {
    if (typeof value !== 'string') return value;
    const m = value.match(/^\{([^}]+)\}$/);
    if (!m) return value;
    const ref = m[1];
    if (seen.has(ref)) throw new Error(`Circular alias reference: {${ref}}`);
    const target = flat.get(ref);
    if (!target) throw new Error(`Unresolved alias {${ref}}`);
    seen.add(ref);
    return resolve(target.value, seen);
  };

  const tokens = { color: {}, typography: {}, radius: {}, spacing: {}, shadow: {}, fonts: [] };
  const fonts = new Set();
  for (const [path, tok] of flat) {
    const value = resolve(tok.value, new Set([path]));
    const parts = path.split('.');
    if (/^colors?$/i.test(parts[0]) && parts.length > 1) parts.shift();
    const name = parts.join('-');
    if (tok.type === 'color' || isColor(value)) {
      if (isColor(value)) tokens.color[name] = value;
      continue;
    }
    if (tok.type === 'typography' || (value && typeof value === 'object' && 'fontFamily' in value)) {
      const t = { fontFamily: value.fontFamily, fontSize: toPx(value.fontSize), fontWeight: typeof value.fontWeight === 'number' ? value.fontWeight : 400 };
      const lh = toPx(value.lineHeight); if (lh != null) t.lineHeight = lh;
      const ls = toPx(value.letterSpacing); if (ls != null) t.letterSpacing = ls;
      tokens.typography[name] = t;
      if (t.fontFamily) fonts.add(t.fontFamily);
      continue;
    }
    const px = toPx(value);
    if (px == null) continue;
    if (/radius|radii|rounded/i.test(path)) tokens.radius[`radius-${parts[parts.length - 1]}`] = px;
    else if (/spacing|space|gap/i.test(path)) tokens.spacing[`spacing-${parts[parts.length - 1]}`] = px;
  }
  tokens.fonts = [...fonts];
  return { tokens, meta: { source: 'design tokens' } };
}
```

NOTE: the radius/spacing names in the tests are `radius-md` (bucket prefix + last path segment) — make sure the implementation and tests agree; if they conflict, the TESTS win, fix the implementation.

- [ ] **Step 4: Run tests** → 6 pass. **Step 5: Full `npm test`** → no regressions. **Step 6: Commit** `feat(import): W3C design-tokens parser`.

---

### Task 2: CSS custom-properties parser

**Files:**
- Create: `src/code-import/css.js`
- Create: `tests/fixtures/code-import/shadcn-globals.css`, `tests/fixtures/code-import/tailwind-v4-theme.css`
- Modify: `tests/code-import.test.js` (append)

- [ ] **Step 1: Fixtures.** `shadcn-globals.css`:

```css
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --radius: 0.5rem;
    --brand: #0969da;
    --ref: var(--brand);
  }
  .dark {
    --background: 222.2 84% 4.9%;
  }
}
```

`tailwind-v4-theme.css`:

```css
@theme {
  --color-primary: oklch(0.55 0.2 250);
  --color-surface: rgb(246, 248, 250);
  --radius-md: 6px;
  --spacing-gutter: 1.5rem;
  --font-sans: "Inter", sans-serif;
}
```

- [ ] **Step 2: Failing tests** (append; import `parseCss` from `../src/code-import/css.js`):

```js
import { parseCss } from '../src/code-import/css.js';

test('css: shadcn bare HSL triples become hex colors', () => {
  const { tokens } = parseCss(fixture('shadcn-globals.css'));
  assert.equal(tokens.color['background'], '#ffffff');
  assert.match(tokens.color['primary'], /^#[0-9a-f]{6}$/);
});

test('css: hex passthrough and var() reference resolution', () => {
  const { tokens } = parseCss(fixture('shadcn-globals.css'));
  assert.equal(tokens.color['brand'], '#0969da');
  assert.equal(tokens.color['ref'], '#0969da');
});

test('css: radius-named rem values become px radius tokens', () => {
  const { tokens } = parseCss(fixture('shadcn-globals.css'));
  assert.equal(tokens.radius['radius'], 8);
});

test('css: .dark block values are skipped in v1 (first definition wins)', () => {
  const { tokens } = parseCss(fixture('shadcn-globals.css'));
  assert.equal(tokens.color['background'], '#ffffff'); // not the .dark value
});

test('css: tailwind v4 @theme — color-/radius-/spacing-/font- prefixes', () => {
  const { tokens } = parseCss(fixture('tailwind-v4-theme.css'));
  assert.match(tokens.color['primary'], /^#[0-9a-f]{6}$/);   // oklch converted
  assert.equal(tokens.color['surface'], '#f6f8fa');           // rgb() converted
  assert.equal(tokens.radius['radius-md'], 6);
  assert.equal(tokens.spacing['spacing-gutter'], 24);
  assert.deepEqual(tokens.fonts, ['Inter']);
});
```

- [ ] **Step 3: Implement `src/code-import/css.js`.** Requirements the code must meet (write it TDD against the tests above):
  - Regex-extract every `--name: value;` declaration in the file, tracking whether the enclosing block selector matches `.dark` / `[data-theme="dark"]` (a simple "current selector" scan: find the nearest preceding `{`'s selector text) — skip declarations inside dark blocks.
  - First definition of a name wins (later re-definitions ignored).
  - Value classification, in order: `var(--ref)` → resolve once against already-collected values; hex → as-is (3-digit expanded to 6); `rgb()/rgba()` → hex; `hsl()/hsla()` → hex; bare HSL triple (`^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$`) → hsl→hex; `oklch()` → hex via conversion helper (implement oklch→sRGB with gamut clamp — ~25 lines, standard matrices); px/rem number → dimension.
  - Name handling: strip `--`; in `@theme` blocks strip Tailwind v4 prefixes: `color-` → color token, `radius-` → radius token named `radius-<rest>`, `spacing-` → spacing named `spacing-<rest>`, `font-` → font family (first quoted/unquoted family name before comma). Outside `@theme`: names containing `radius` → radius bucket; containing `spacing|space|gap` → spacing; color-valued → color; other dimensions ignored.
  - hsl→hex helper: standard HSL→RGB. Round each channel.
  - Export `parseCss(cssText) → { tokens, meta: { source: 'css variables' } }`.

- [ ] **Step 4: Tests pass** (11 total in file). **Step 5: `npm test`.** **Step 6: Commit** `feat(import): CSS custom-properties parser (shadcn HSL, Tailwind v4 @theme, oklch)`.

---

### Task 3: Tailwind config loader

**Files:**
- Create: `src/code-import/tailwind.js`
- Create: `tests/fixtures/code-import/tailwind.config.cjs`
- Modify: `tests/code-import.test.js` (append)

- [ ] **Step 1: Fixture** `tailwind.config.cjs` (CJS so the test loads it without a project node_modules):

```js
module.exports = {
  theme: {
    colors: {
      transparent: 'transparent',
      blue: { 50: '#eff6ff', 500: '#3b82f6', 900: '#1e3a8a' },
      white: '#ffffff',
    },
    borderRadius: { sm: '0.125rem', md: '0.375rem', full: '9999px' },
    spacing: { 1: '0.25rem', 4: '1rem' },
    fontFamily: { sans: ['Inter', 'sans-serif'], mono: ['SF Mono'] },
    fontSize: { sm: ['14px', { lineHeight: '20px' }], base: '16px' },
    extend: {
      colors: { brand: '#0969da' },
    },
  },
};
```

- [ ] **Step 2: Failing tests** (append):

```js
import { parseTailwindConfig } from '../src/code-import/tailwind.js';

test('tailwind: flattens nested color scales, skips non-colors, merges extend', async () => {
  const { tokens } = await parseTailwindConfig(join(FIX, 'tailwind.config.cjs'));
  assert.equal(tokens.color['blue-500'], '#3b82f6');
  assert.equal(tokens.color['white'], '#ffffff');
  assert.equal(tokens.color['brand'], '#0969da');       // from extend
  assert.equal(tokens.color['transparent'], undefined); // skipped
});

test('tailwind: borderRadius/spacing rem→px, fontFamily, fontSize tuples', async () => {
  const { tokens } = await parseTailwindConfig(join(FIX, 'tailwind.config.cjs'));
  assert.equal(tokens.radius['radius-md'], 6);
  assert.equal(tokens.radius['radius-full'], 9999);
  assert.equal(tokens.spacing['spacing-4'], 16);
  assert.deepEqual(tokens.fonts.sort(), ['Inter', 'SF Mono']);
  assert.equal(tokens.typography['text-sm'].fontSize, 14);
  assert.equal(tokens.typography['text-sm'].lineHeight, 20);
  assert.equal(tokens.typography['text-base'].fontSize, 16);
});

test('tailwind: unloadable config throws a helpful error', async () => {
  await assert.rejects(() => parseTailwindConfig('/nonexistent/tailwind.config.js'), /load|find/i);
});
```

- [ ] **Step 3: Implement `src/code-import/tailwind.js`:**
  - `export async function parseTailwindConfig(configPath)`.
  - Load: `const mod = await import(pathToFileURL(resolve(configPath)).href)` inside try/catch; config = `mod.default ?? mod`. CJS works through Node's ESM-CJS interop. On error: throw `Cannot load <path>: <err.message>. If this is a Tailwind v4 project, import the CSS file with @theme instead (figma-cli import styles.css), or export your tokens as JSON.` (TS configs: the import() either works on this Node version or lands in the same error.)
  - Theme resolution: `merged = { ...theme, ...theme.extend }` per top-level key (extend merges INTO base per key: `{...theme.colors, ...theme.extend?.colors}` etc.).
  - Colors: recursive flatten with `-` joins; only string values matching `/^(#|rgb|hsl)/`; skip `inherit|currentColor|transparent`.
  - borderRadius → `radius-<key>` (rem ×16, px direct); spacing → `spacing-<key>`; fontFamily values (array or string) → first family of each into `fonts`; fontSize → typography `text-<key>`: value string → `{fontFamily: <first sans family or 'Inter'>, fontSize, fontWeight: 400}`, tuple form `[size, {lineHeight}]` adds lineHeight.
  - Functions as theme values (e.g. `({theme}) => …`): skip silently (count them; if EVERYTHING was functions, throw the helpful error).
  - Return `{ tokens, meta: { source: basename of project dir + ' tailwind' } }`.

- [ ] **Step 4: Tests pass.** **Step 5: `npm test`.** **Step 6: Commit** `feat(import): Tailwind config parser (child-free dynamic import, extend merge)`.

NOTE: the spec said child process — dynamic `import()` in-process is simpler and sufficient (configs are trusted local files; the CLI already executes arbitrary project code paths). Document this deviation in the commit body: in-process import() chosen over child process, configs are the user's own code.

---

### Task 4: Storybook parser

**Files:**
- Create: `src/code-import/storybook.js`
- Create: `tests/fixtures/code-import/storybook-index.json`
- Modify: `tests/code-import.test.js` (append)

- [ ] **Step 1: Fixture** `storybook-index.json` (Storybook 8 shape):

```json
{
  "v": 5,
  "entries": {
    "components-button--primary": { "id": "components-button--primary", "title": "Components/Button", "name": "Primary", "type": "story" },
    "components-button--secondary": { "id": "components-button--secondary", "title": "Components/Button", "name": "Secondary", "type": "story" },
    "components-button--docs": { "id": "components-button--docs", "title": "Components/Button", "name": "Docs", "type": "docs" },
    "components-badge--default": { "id": "components-badge--default", "title": "Components/Badge", "name": "Default", "type": "story" }
  }
}
```

- [ ] **Step 2: Failing tests** (append):

```js
import { parseStorybookIndex, fetchStorybookIndex } from '../src/code-import/storybook.js';

test('storybook: groups stories by component, skips docs entries', () => {
  const { meta } = parseStorybookIndex(fixture('storybook-index.json'));
  assert.equal(meta.components.length, 2);
  const button = meta.components.find(c => c.name === 'Button');
  assert.deepEqual(button.variants, ['Primary', 'Secondary']);
  assert.equal(button.category, 'Components');
});

test('storybook: produces empty tokens (index.json has none)', () => {
  const { tokens } = parseStorybookIndex(fixture('storybook-index.json'));
  assert.equal(Object.keys(tokens.color).length, 0);
});

test('storybook: v6 stories.json shape also parses', () => {
  const v6 = JSON.stringify({ v: 3, stories: {
    'button--primary': { id: 'button--primary', title: 'Button', name: 'Primary', kind: 'Button' },
  } });
  const { meta } = parseStorybookIndex(v6);
  assert.equal(meta.components[0].name, 'Button');
});
```

- [ ] **Step 3: Implement `src/code-import/storybook.js`:**
  - `parseStorybookIndex(jsonText)`: accepts `entries` (v7/8/9 index.json) or `stories` (v6 stories.json). Group by `title`; component name = last `/` segment of title; category = the rest. Skip `type === 'docs'`. Variants = story `name`s in order. Returns `{ tokens: <all-empty shape>, meta: { source: 'Storybook', components: [{name, category, variants}] } }`.
  - `fetchStorybookIndex(urlOrDir)`: if `/^https?:\/\//` → `fetch(url.replace(/\/$/, '') + '/index.json', { signal: AbortSignal.timeout(5000) })`, on 404 retry `/stories.json`, on network error throw `Could not reach Storybook at <url> — is it running?`. Else treat as directory: read `<dir>/index.json` or `<dir>/storybook-static/index.json` (first that exists), error listing both paths tried. Returns the raw text.

- [ ] **Step 4: Tests pass.** **Step 5: `npm test`.** **Step 6: Commit** `feat(import): Storybook index parser (v6-v9, URL or static build)`.

---

### Task 5: Converter dispatcher + DESIGN.md rendering

**Files:**
- Create: `src/code-import/index.js`
- Modify: `tests/code-import.test.js` (append)

- [ ] **Step 1: Failing tests** (append):

```js
import { convert, detectSourceType } from '../src/code-import/index.js';
import { parseDesignMd } from '../src/design-md.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('detect: filenames and content sniffing', () => {
  assert.equal(detectSourceType('tailwind.config.js', ''), 'tailwind');
  assert.equal(detectSourceType('a/b/tailwind.config.ts', ''), 'tailwind');
  assert.equal(detectSourceType('globals.css', ''), 'css');
  assert.equal(detectSourceType('tokens.json', '{"color":{"a":{"$value":"#fff"}}}'), 'tokens');
  assert.equal(detectSourceType('index.json', '{"v":5,"entries":{}}'), 'storybook');
  assert.equal(detectSourceType('http://localhost:6006', ''), 'storybook');
});

test('convert: every converter designMd output roundtrips through parseDesignMd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-import-'));
  for (const [src, type] of [
    [join(FIX, 'tokens-style-dictionary.json'), 'tokens'],
    [join(FIX, 'shadcn-globals.css'), 'css'],
    [join(FIX, 'tailwind.config.cjs'), 'tailwind'],
  ]) {
    const result = await convert(src, { type });
    const f = join(dir, `out-${type}.md`);
    writeFileSync(f, result.designMd);
    const parsed = parseDesignMd(f);
    assert.ok(Object.keys(parsed.tokens.color).length > 0, `${type}: colors survive roundtrip`);
  }
});

test('convert: storybook produces components in designMd and zero tokens', async () => {
  const result = await convert(join(FIX, 'storybook-index.json'), { type: 'storybook' });
  assert.match(result.designMd, /### Button/);
  assert.match(result.designMd, /Primary, Secondary/);
  assert.equal(Object.keys(result.tokens.color).length, 0);
});
```

- [ ] **Step 2: Implement `src/code-import/index.js`:**
  - `detectSourceType(source, contentSample)`: URL → storybook; basename starts `tailwind.config.` → tailwind; `.css` → css; `.json` → sniff content: has `"$value"` or `"value"` nested under groups → tokens, has `"entries"` or `"stories"` top-level key → storybook; `.md` → designmd; directory → storybook. Unknown → null.
  - `convert(source, { type } = {})`: resolve type (param wins, else detect from name + first 2KB of content), dispatch to the Task 1-4 parsers (storybook: `fetchStorybookIndex` for URL/dir, direct read for .json file), then render `designMd` via a local `renderDesignMd(tokens, meta)`:
    - Header: `# DESIGN.md -- <meta.source>`, extraction-meta comment (`source`, `generator: figma-cli import (<type>)`), `## 1. Identity` with `**In one line:** Design tokens imported from <type> (<N> colors, <M> components).`
    - If `meta.components?.length`: `## 2. Components` with per-component `### <name>` + `Variants: <comma list>` (matches the regex sniffs in setup.js? — NOT needed, this file is consumed by parseDesignMd directly, not re-sniffed).
    - Final section: `## 3. Machine-readable tokens` + ```` ```json design-tokens ```` block with `{ $schema, meta: {source, generated}, color, typography, spacing, radius (values as "<n>px" strings), shadow, fonts }`. Use a `generated` date passed in by the caller (`new Date()` is fine here — this is the CLI, not a workflow).
    - Returns `{ tokens, meta, designMd }`.

- [ ] **Step 3: Tests pass** (17 in file). **Step 4: `npm test`.** **Step 5: Commit** `feat(import): source detection + DESIGN.md rendering for code imports`.

---

### Task 6: Wire into the `import` command + docs

**Files:**
- Modify: `src/commands/setup.js` (the `import` command action)
- Modify: `CLAUDE.md`, `docs/COMMANDS.md`, `README.md`

- [ ] **Step 1: Extend the import command.** In `src/commands/setup.js`, the `import <file>` action currently: reads the file, sniffs DESIGN.md formats, forwards to `tokens import-design-md`, else errors. Change to:
  1. Add options: `--save <file>` (write converted DESIGN.md), `--type <type>` (override detection).
  2. BEFORE the `readFileSync`: if source is a URL or a directory, or `detectSourceType(basename)` matches tailwind/css, go to the code-import branch directly (URL/dir must not hit readFileSync).
  3. For files: read content; if the existing DESIGN.md sniffs match → existing path (unchanged). Else `detectSourceType(file, content)`; if a code-import type → code-import branch; else the existing "Unrecognized format" error, now also listing the new formats.
  4. Code-import branch: `const result = await convert(source, { type: options.type })`. If `--save`, write `result.designMd` there; else write to a temp file (`os.tmpdir()`). If tokens are non-empty → forward the written file to the existing machinery exactly like the DESIGN.md path does (`program.parseAsync(['tokens', 'import-design-md', <path>, …], { from: 'user' })`). If tokens are empty but components exist (storybook) → do NOT create variables; if no `--save` was given, save to `./DESIGN-storybook.md`; print the components context (count + first few names) and the hint: `Storybook gives component context, not tokens — combine with: figma-cli import tailwind.config.js`.
  5. Update the error help text to list all supported sources.

- [ ] **Step 2: Smoke tests** (no Figma needed):
  - `node src/index.js import tests/fixtures/code-import/storybook-index.json` → prints component context, writes DESIGN-storybook.md, does NOT attempt connection. Delete the file after.
  - `node src/index.js import /nonexistent.xyz` → helpful error listing supported formats.

- [ ] **Step 3: Docs.**
  - CLAUDE.md Quick Reference rows: "import my tailwind colors" → `figma-cli import tailwind.config.js`; "import our css variables" → `figma-cli import src/globals.css`; "import design tokens json" → `figma-cli import tokens.json`; "load our storybook" → `figma-cli import http://localhost:6006`.
  - CLAUDE.md: extend the "Bring your own design system" knowledge — short block under the DESIGN.md Export section: what each source yields, storybook = components-context-only.
  - docs/COMMANDS.md: extend the import section with the new sources, `--save`, `--type`.
  - README.md "Bring your own design system": add one paragraph — DESIGN.md is no longer the only way in; tailwind config, css variables, tokens JSON and storybook work directly. Match the README's style: no em dashes, no Oxford comma, the " , " comma rhythm.

- [ ] **Step 4: `npm test`** → all pass. **Step 5: Commit** `feat(import): tailwind/css/tokens/storybook sources for figma-cli import + docs`.

---

### Task 7: Live verification (needs Figma open + connected)

- [ ] **Step 1:** Create a realistic test project in /tmp: a tailwind.config.cjs (copy the fixture), a shadcn-style globals.css. Run `node src/index.js import /tmp/<proj>/tailwind.config.cjs -c "tw-test"` → variables appear in Figma (verify via `figma-cli var list` filtered to the collection: blue-50/500/900, brand, radius tokens).
- [ ] **Step 2:** `node src/index.js import /tmp/<proj>/globals.css -c "css-test"` → background/primary/border variables exist.
- [ ] **Step 3:** Cleanup: `figma-cli var delete-all -c "tw-test"`, same for `css-test` (ONLY these collections — never touch others).
- [ ] **Step 4:** Fix anything found; commit fixes.

---

## Self-review notes

- Spec coverage: tailwind (T3), css incl. @theme + oklch + shadcn HSL (T2), W3C tokens (T1), storybook URL/static + components context + zero-token behavior (T4, T6), shared convert contract + designMd roundtrip (T5), CLI detection + --save/--type + natural-language docs (T6), live acceptance (T7). Deviation from spec: tailwind loads in-process instead of child process — documented in T3.
- Out of scope per spec: argTypes/CSF, dark modes, SCSS, generic component parsing.
- Type consistency: all parsers return the same normalized `{ tokens, meta }`; only `parseTailwindConfig` is async (file import) — `convert()` is async, callers await.
