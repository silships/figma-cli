# Changelog

## Unreleased

### New

- **Variable-collection roundtrip.** `figma-cli extract` now captures the file's real variable collections , every variable with its true name, all its modes (light/dark, high-contrast, colour-blind, whatever the system defines) and its alias chains , into a `## Variables` section plus the machine-readable JSON token block. This is the authoritative token layer, not the palette sampled from fills. `figma-cli import` recreates those collections faithfully (modes and aliases included) in any other file, closing the variables roundtrip. Captured in bounded chunks so large systems (thousands of variables) don't time out, and aliases to library/remote variables resolve to their real names.
- **`figma-cli extract --sections variables`** for a variables-only export.

### Fixed

- `extract`: PERCENT line-heights now resolve to absolute px (a Figma "142%" was emitted as a raw `142.85px`, breaking the type scale and re-import).

### Changed

- Variable / collection / mode names and string token values are escaped for markdown tables (`|`, newlines); duplicate collection names are suffixed ` (2)` instead of overwriting each other.

### Tests

- Variable capture, alias resolution, markdown escaping, chunked import and the full extract→import roundtrip are covered by new unit tests (238 total, CI on Node 18/20/22).

## 2.1.0 (2026-06-17)

### New

- **DESIGN.md export (`figma-cli extract`).** Scans every page (no truncation, even on 100k+ node files) and writes a DESIGN.md with the full token map (colors ranked by usage, type scale, spacing, radii, shadows) plus a variant matrix for every component set. Oversized structure trees auto-split into `DESIGN-structure/` so the main file stays AI-context-sized. Roundtrips with `import`.
- **Import from code sources.** `figma-cli import` accepts Tailwind config (`tailwind.config.js`), CSS custom properties (shadcn HSL, Tailwind v4 `@theme`, oklch), W3C / Style Dictionary design-tokens JSON, and Storybook (URL or static build). A prose-DESIGN.md parser imports brand systems written as `**Name** (#hex): role` rows.
- **Reuse, don't rebuild.** Extracted components carry a key→id reuse handle; `figma-cli instantiate <name>` drops a real instance (same-file via id, cross-file via library key) and `spec` surfaces the handle as the recommended path.
- **`figma-cli spec` / `spec --check`.** Reads a component's authoritative spec from the DESIGN.md in code (zero model tokens) and enforces it against a built node (component-set, axes, height).
- **`export dtcg`** , W3C Design Tokens (DTCG) JSON export, so tokens round-trip both ways.
- **Gradient tools.** `gradient extract` rebuilds linear/mesh gradients from an image; `gradient mesh` generates wallpapers from a colour palette with rotating composition styles and optional `--grain` / `--texture`.
- **`variants from`** turns frames/components into a real Variant Set; **`unstack`** non-destructively fixes overlapping top-level nodes.
- **JSX additions:** `<Ellipse>` / `<Circle>` (rings, spinners, donut, pie), `flex="none"` z-stacks, percentage `w`/`h`, `lineHeight` / `letterSpacing` / alignment / truncation, and native Figma effects (`noise`, `texture`, `progressiveBlur`, `glass`).
- **`init-agent`** , one-command Cursor + Claude Code setup (drops `.cursor/rules/figma-cli.mdc`).
- **shadcn `--count`** yields N *distinct*, descriptively-named designs (e.g. buttons, cards) instead of N clones.
- Unknown-prop warnings with suggestions, `justify="between"` on nested frames, custom fonts with full weight scale + fallback, `figma-cli undo`, and `render --verify` / `render-batch --verify`.

### Changed

- `src/index.js` (10.7k lines) split into `src/lib/cli-core.js` and command modules under `src/commands/`. Single render and render-batch share one child generator (batch now supports Icon/Rect/Image/Instance/Slot children, absolute positioning, wrap, strokeWidth, grow).
- All user input interpolated into generated plugin code is JSON-escaped (`Brand's Colors` no longer breaks rendering).
- Daemon reliability: backoff + health check, no blind retry on a healthy connection, self-heal, longer idle window; shadcn components render with sensible variable fallbacks instead of grey-on-grey.

### Fixed

- `hexToRgb` returns null on invalid hex (no silent black fills); stretch + thin-divider cross-axis fill; sane top-left alignment defaults for nested frames; `rowGap` honoured on wrap rows.

## 2.0.0 (2026-02-26)

### New

- **Safe Mode** , plugin-based connection that needs no Figma patching, alongside Yolo (direct CDP). Setup picks the right one.
- **`recreate-url` / `screenshot-url`** , recreate or screenshot a webpage in Figma.
- **Multi-font support** with automatic fallback; **Instance** element in JSX; vertical `render-batch`.
- **`create image`** , import an image into Figma from a URL.

### Changed

- Switched to figma-use render for full JSX support; auto-patch on first `connect`.

### Fixed

- Figma v39+ compatibility (locates the sandboxed execution context); daemon retry + health check; smart positioning for `render` / `render-batch`; auto-layout clipping, sizing and nesting.
