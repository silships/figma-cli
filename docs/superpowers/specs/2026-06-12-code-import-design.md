# Design: Code & Storybook import — design system context from code

**Date:** 2026-06-12
**Status:** Draft (pending Sil's review)

## Goal

Let users load design system context into figma-cli from the places it already
lives in code — without writing a DESIGN.md by hand:

1. **Token sources (Part A):** Tailwind config, CSS custom properties
   (incl. Tailwind v4 `@theme` blocks), W3C design-tokens JSON
   (Style Dictionary / Tokens Studio).
2. **Storybook (Part B):** component inventory + variant lists from a running
   instance or a static build.

Everything converges on the existing hub: each source converts to the
**normalized token shape** that `parseDesignMd()` already returns
(`{ tokens: { color, typography, radius, spacing, shadow, fonts }, meta }`),
then flows through the existing pipeline (`toTokensImportJson` → Figma
variables, `summarizeForLLM` → figmachat/Claude context). DESIGN.md stays the
single interchange format; `--save` writes the intermediate file.

## CLI surface

No new command to memorize — `figma-cli import <source>` detects the source:

| Source | Detection | Parser |
|---|---|---|
| `*.md` | extension | existing `parseDesignMd` (unchanged) |
| `tailwind.config.{js,cjs,mjs,ts}` | filename | Tailwind theme parser |
| `*.css` | extension | CSS custom-props / `@theme` parser |
| `*.json` with `$value` keys (nested) | content sniff | W3C design-tokens parser |
| `*.json` with `v` + `entries` keys | content sniff | Storybook index parser |
| `http(s)://…` | URL | Storybook instance (fetches `<url>/index.json`) |
| directory | contains `storybook-static/index.json` or `index.json` | Storybook static build |

Flags (added to the existing `import` command):
- `--save <file>` — also write the converted DESIGN.md to disk
- `--type <tailwind|css|tokens|storybook>` — override detection
- `-c, --collection <name>` — existing flag, unchanged

Natural-language mappings (CLAUDE.md Quick Reference):
"import my tailwind colors" → `figma-cli import tailwind.config.js`,
"import our css variables" → `figma-cli import src/globals.css`,
"load our storybook" → `figma-cli import http://localhost:6006`.

## Part A: token sources

### Tailwind config (`src/code-import/tailwind.js`)

- Load via dynamic `import()` in a **child process** with cwd = config's
  directory (configs may `require` tailwind plugins/defaultTheme — needs the
  project's node_modules). `createRequire` fallback for CJS. On load failure:
  clear error suggesting `--type css` (v4) or a tokens JSON export. TS configs:
  try `import()` (works on modern Node with strip-types), else same error.
- Extract from `theme` + `theme.extend` (extend wins):
  - `colors`: flatten nested scales (`blue: {50: …}` → `blue-50`), skip
    `inherit/current/transparent`, resolve only string values (hex, rgb(),
    hsl() → hex)
  - `borderRadius` → radius tokens (rem→px ×16, named: `sm/md/lg/full…`)
  - `spacing` → spacing tokens (rem→px)
  - `fontFamily` → fonts list; `fontSize` → typography scale (size +
    lineHeight when the tuple form is used)
- Names stay **literal** (`blue-500`, not semantic remapping) — Tailwind scales
  are primitives, same convention as the existing `tokens tailwind` preset.

### CSS custom properties (`src/code-import/css.js`)

- Parse `:root { … }`, `@theme { … }` (Tailwind v4), `[data-theme=…]` and
  `.dark` blocks. Regex-based (no PostCSS dependency): match
  `--name:\s*value;` declarations.
- Color values: hex, rgb()/rgba(), hsl()/hsla(), oklch() → convert to hex
  (oklch via a small conversion helper; out-of-gamut clamps). shadcn-style
  bare HSL triples (`--primary: 222.2 47.4% 11.2%`) are detected and treated
  as HSL.
- `var(--ref)` references resolved one level within the same file.
- px/rem values whose names contain `radius` → radius tokens; `spacing|space|gap`
  → spacing tokens. Everything else numeric is ignored (YAGNI).
- `.dark` / second theme block: imported as additional mode ONLY if the
  existing variables pipeline supports modes for this path — otherwise dark
  values are skipped with a notice (documented limitation, follow-up).

### W3C design-tokens JSON (`src/code-import/w3c-tokens.js`)

- Walk nested groups; a token = object with `$value` (also accept legacy
  `value`). `$type`/type inference: color (string starting with `#`/`rgb`/
  `hsl`), dimension (px/rem → number), typography (object with fontFamily…),
  shadow (object/array with offsetX…).
- Token names: path joined with `-` (`color.brand.primary` → `brand-primary`;
  leading `color`/`colors` group name dropped).
- Alias references `{color.brand.primary}` resolved within the document
  (one pass, cycles error out).

## Part B: Storybook

### Source resolution (`src/code-import/storybook.js`)

- URL → fetch `<url>/index.json` (Storybook 7/8/9). Fallback `<url>/stories.json`
  (v6). 5s timeout, friendly error ("is Storybook running?").
- Directory → read `storybook-static/index.json` or `<dir>/index.json`.

### What it produces (v1 — honest scope)

`index.json` has **no argTypes** (they're runtime data). But story names per
component are a real variant signal: `Button` with stories
`Primary, Secondary, Danger, Disabled` IS the variant list.

- Group entries by `title` (`Components/Button` → component `Button`,
  category `Components`); `type: 'docs'` entries skipped.
- Output: a **components context** — for each component: name, category,
  story names as variant list. No tokens (index.json has none).
- This lands in: the converted DESIGN.md's **Components section** (same format
  extract writes: `### Button` + variant table) + `summarizeForLLM` context so
  figmachat/Claude knows the component vocabulary of the codebase.
- If the import yields zero color/radius/typography tokens, SKIP variable
  creation entirely and say so: "Storybook gives component context, not tokens —
  combine with `figma-cli import tailwind.config.js` for colors." The DESIGN.md
  (via `--save` or auto-saved to `DESIGN-storybook.md` in cwd) is the artifact.
- **Follow-up (not v1):** argTypes via CSF source parsing or `storybook extract`
  (needs headless browser), story screenshots as visual reference.

### meta.components plumbing

`summarizeForLLM` already prints `Existing component pages` from
`meta.components` — Storybook components reuse that field (rename the label to
"Components" when the source is storybook).

## Shared converter contract (`src/code-import/index.js`)

```
convert(source, { type? }) → {
  tokens: { color, typography, radius, spacing, shadow, fonts },  // may be partially empty
  meta:   { source, generated, identity, components: [{name, variants[]}] | string[] },
  designMd: string   // the equivalent DESIGN.md (Format B with json design-tokens block)
}
```

`import` command flow: detect type → `convert()` → if `--save`, write
`designMd` → if tokens non-empty, existing variable-creation path → always
print `summarizeForLLM` context.

## Error handling

- Unknown/ambiguous source: list what was tried, suggest `--type`.
- Tailwind config that fails to load: error names the underlying exception,
  suggests CSS/tokens-JSON alternatives. Never regex-scrape JS as fallback
  (silently wrong > loudly broken).
- Empty result (0 tokens, 0 components): fail with "nothing importable found
  in <source>" rather than creating an empty collection.

## Testing

- Unit tests with fixtures (no Figma needed): a realistic tailwind.config.js
  (nested colors, extend, fontSize tuples), a shadcn globals.css (HSL triples,
  .dark block), a Tailwind v4 @theme CSS, a Style-Dictionary tokens.json
  (aliases), a Storybook 8 index.json.
- Converter contract test: every converter's `designMd` output parses with
  `parseDesignMd()` (same roundtrip guarantee as extract).
- Live test: import a real tailwind config → variables appear in Figma
  (manual acceptance, like Task 8 of extract).

## Non-goals (v1)

- Storybook argTypes / CSF parsing / screenshots (follow-up)
- Dark-mode/multi-theme modes for CSS imports (notice + follow-up)
- Generic React/Vue component source parsing (an AI reads code better than a
  regex — that's what Claude itself is for)
- SCSS/LESS variables, styled-components themes
