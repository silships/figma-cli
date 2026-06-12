# Design: `figma-cli extract` — DESIGN.md exporter

**Date:** 2026-06-12
**Status:** Approved (brainstormed with Sil)

## Goal

A CLI command that scans the currently open Figma file (all pages by default) and
generates a DESIGN.md in the same 11-section format as the "Design to Markdown"
community plugin — but better:

- **No truncation.** The plugin only emitted detailed structure for 10 of 67 pages
  on the Primer Web file (cut off alphabetically after "Avatars"). We walk every
  page, one daemon call per page, and assemble the markdown on the Node side where
  there are no output-size limits.
- **Variant matrices instead of flat lists.** A component set is described ONCE
  (detail tree of one variant + a property table like
  `trigger: icon-button | button, open: true | false, align: left | center | right`)
  instead of dumping 2483 component names or full trees per variant.
- **Roundtrip-guaranteed.** Output must parse cleanly with our own importer
  (`figma-cli import` / `src/design-md.js`), including the
  `## 11. Machine-readable tokens` `json design-tokens` block.
- **Scope + section selection via flags** instead of plugin UI.

## CLI surface

```
figma-cli extract [output.md]          # default output: ./DESIGN.md
  --sections <list>                    # comma list; default: all 11
                                       # (identity,structure,color,typography,
                                       #  spacing,depth,components,states,rules,
                                       #  extending,tokens)
  --pages "<name,name>"                # only these pages (substring match, case-insensitive)
  --selection                          # only current selection (overrides --pages)
  --split                              # additionally write full per-page trees to
                                       # DESIGN-structure/<page-slug>.md
```

`--sections tokens` gives a tokens-only export; default is the full document.

## Architecture

Three units, mirroring the existing import pipeline in reverse:

### 1. Page walker (runs inside Figma via daemon eval)

- One eval call to list pages: `await figma.loadAllPagesAsync()` →
  `[{id, name, topLevelFrameCount}]`.
- Then **one eval call per page** (avoids timeouts/memory pressure on 124k-node
  files). Each call walks that page's tree and returns compact JSON per node:
  - type, name, width/height (rounded)
  - auto-layout: layoutMode, itemSpacing, padding (t/r/b/l), primary/counter
    axis alignment, sizing modes
  - fills/strokes resolved to hex (+ opacity), strokeWeight
  - cornerRadius (per-corner if mixed)
  - effects (shadows: offset/blur/spread/color; blurs)
  - text: characters (truncated to ~80 chars), fontName, fontSize, fontWeight,
    lineHeight, letterSpacing
  - COMPONENT_SET: `variantGroupProperties` (the variant matrix), child count;
    children NOT fully expanded — only the first variant's tree as the detail
    sample
  - INSTANCE: main component name only, children not expanded
  - depth cap per tree branch (default 8) with explicit `…and N more` markers
    that include the count (never silent truncation)
- Walker code lives as a template string in `src/design-extract.js` and is sent
  through the existing `figmaEval()` helper (`src/lib/cli-core.js`).

### 2. Aggregator (Node side, `src/design-extract.js`)

- Collects per-page JSON, then derives:
  - **Color census:** usage-counted unique fills/strokes → palette ranked by
    usage; named local paint styles take priority over raw values (same rule
    the plugin uses).
  - **Typography census:** unique (family, size, weight, lineHeight,
    letterSpacing) tuples → type scale, named text styles first.
  - **Spacing/radius census:** gaps, paddings, corner radii with counts → base
    unit inference (GCD-ish heuristic over the most common values).
  - **Shadow census:** unique effect compositions.
  - **Component sets:** name, variant property matrix, sample tree, page.
  - **Dedup:** identical sibling subtrees (e.g. 30 equal buttons in a sticker
    sheet) collapse to one tree + `×N` marker.

### 3. Markdown writer (Node side, same module)

- Emits the 11 sections in the plugin-compatible layout (headers `## 1. Identity`
  … `## 11. Machine-readable tokens`) so `parseDesignMd()` reads it unchanged.
- Section 2 (Structure): per page, top-level frames with the compressed tree
  notation already used by the plugin (`name · TYPE · WxH · layout, gap, padding`).
- Section 7 (Components): grouped by component set with variant matrices.
- Section 11: full `json design-tokens` block (color, typography, spacing,
  radius, shadow, fonts) — must round-trip through `toTokensImportJson()`.
- `--split`: additionally write uncompressed per-page trees to
  `DESIGN-structure/<page-slug>.md`.

### Command registration

New file `src/commands/extract.js`, registered from `src/index.js` like the other
command modules. Core logic in `src/design-extract.js` (sibling to
`src/design-md.js`).

## Progress UX

`ora` spinner with per-page progress: `Page 12/67: ActionList…`. Final summary:
pages scanned, nodes visited, counts per token type, output path(s).

## Error handling

- Not connected / daemon down → same friendly error as other commands.
- A single page failing (eval error, timeout) → warn, record
  `<!-- page "X" skipped: reason -->` in the markdown, continue. Never abort the
  whole run for one page.
- Huge single page → walker depth cap + per-node character budget keeps each
  eval response bounded; if a page response still exceeds the daemon payload
  limit, retry that page with depth cap −2 (down to a floor of 3) and note the
  reduced depth in the output.

## Testing

1. **Roundtrip test:** `extract` against a known file → `parseDesignMd()` on the
   output → token counts and values match what the walker collected.
2. **Unit tests** for the aggregator (color census, base-unit inference, variant
   matrix building, dedup) with fixture JSON — no Figma needed.
3. **Real-world check:** run against the open Primer Web file; verify all 67
   pages appear in Section 2 and ActionMenu's variant matrix matches the known
   properties (trigger/open/align).

## Non-goals

- No REST-API mode (works only against the open desktop file, like the rest of
  figma-cli).
- No image/asset export.
- No diffing between extractions (future idea).
