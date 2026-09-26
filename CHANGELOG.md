# Changelog

## 2.2.5 (2026-09-26)

### Fixed

- The daemon is only restarted when it runs an older version than the CLI. With two installs of different versions (global and project-local) they no longer restart each other on every command; the newer daemon stays

## 2.2.4 (2026-09-26)

### Fixed

- After an update the old background daemon kept serving `render-batch` and `eval` with the previous version's code until it idled out. The daemon now reports its version and figma-cli restarts it when it does not match
- `render '<Instance component="Card" />'` and `render-batch` with instances place the instances directly on the page instead of failing with "must start with <Frame>"

### Changed

- The agent rules and the `eval` output limit point to `figma-cli verify <id> --scale 2` for a sharper screenshot

## 2.2.3 (2026-09-26)

### Added

- `render --file ui.jsx` and `render-batch --file frames.json` read the JSX from a file, so long or generated layouts need no shell quoting
- Text layers take `name="..."` and `decoration="strikethrough|underline"`
- `<Text>` and `<Instance>` accept `position="absolute" x y` like frames do
- Bare numbers such as `x=48` are read as numbers
- `<Instance tint="#hex|var:name">` recolors the vectors inside an instance, for example an icon per state

### Changed

- Icons load with one request per icon set and are cached on disk in `~/.figma-ds-cli/icons`, so a flaky network no longer turns them into placeholders
- When an icon cannot be loaded, render says so in a `note:` line instead of silently drawing a square
- Frames with auto-layout keep strokes out of the layout, like the Figma editor. Children with `w="fill"` span the full width inside a bordered card

## 2.2.2 (2026-09-25)

### Added

- Images from the web in `render`: `image="https://..."` on frames and rectangles and `<Image src="https://..." />`. figma-cli downloads the file itself, so it also works while a plugin with network restrictions is open in the file
- A lone `<Rectangle ... />` is accepted as the outermost element of `render`
- Text in a column with `items="center"` is centered automatically. `align` still wins
- The daemon loads all pages in the background right after connecting, so the first command in a large file does not wait for page loading
- The agent rules explain images and absolute positioning and clipping

### Fixed

- `<Image>` `<Rect>` `<Ellipse>` and `<Slot>` were dropped when a quoted value contained a `/` (for example a URL)
- The live test scripts remove their pages when they finish

## 2.2.1 (2026-09-25)

### Added: new versions reach users without extra steps

- figma-cli tells you once a day when a newer version is on npm, with the command to update. The hint goes to stderr so scripts that read stdout are not affected. Turn it off with `FIGMA_CLI_NO_UPDATE_CHECK=1`
- `figma-cli connect` writes `AGENTS.md` into a project folder that has none yet (a folder with `.git` or `package.json` or `CLAUDE.md` or `.cursor`). It never writes into the home folder or a folder that is not a project

## 2.2.0 (2026-09-25)

### Added: AI agents finish Figma tasks in fewer calls

- `render --page "Name"` and `render-batch --page "Name"` render on that page and create it when missing
- `render` prints the structure it built (sizes and layout and padding and bound variables and which component each instance uses)
- `<Instance component="Button" variant="size=large" text="Save" />` finds a component on any page and picks the variant and relabels it
- `effectStyle="..."` on frames and `textStyle="..."` on text
- `render-batch --variant-set Button` turns frames named `prop=value, prop=value` into one component set
- `eval` helpers: `$page` `$var` `$bind` `$style` `$component` `$instance` `$fontSafe` `$describe`
- Fonts that are not installed are swapped to Inter so instances can be relabelled and moved into frames
- `init-agent` rules carry a version marker and `connect` refreshes an outdated AGENTS.md

### Changed

- `eval` output to a pipe is compact JSON capped at 20,000 characters. A terminal still gets indented JSON

### Fixed

- `pt` `pr` `pb` `pl` on the outermost frame were ignored
- `instantiate` hung forever on a library key that was never published
- The live roundtrip test left fixture pages in the connected file


## 2.1.1 and 2.1.2 (2026-08-12)

### Fixed — auto-layout

The recurring "auto-layout is behaving weirdly" reports had one root cause:
identical JSX was laid out by **different code** depending on where it sat and
which command created it. `render` chose between three implementations (the JSX
parser, a "fast path", and the external `figma-use` binary), `render-batch`
always used the parser, and the parser's root and nested branches disagreed with
each other. A live harness that renders the same JSX through both commands and
diffs the resulting node trees by numbers found **9 of 10 cases differing**.

- **A Frame without `flex` is now a column at every depth.** It used to be a
  column at the root and a **row** when nested — the layout direction silently
  flipped with nesting depth.
- **Nested frames no longer center their children by accident.** A frame without
  an explicit `flex` was treated as a row for alignment, so plain wrapper frames
  set `counterAxisAlignItems = CENTER` and quietly centered titles and cells.
  Alignment now resolves through one shared helper: rows center their cross axis
  (icon+text in a row), everything else reads top-left, at every depth.
- **A fill child in a hugging parent no longer collapses to 1px.** Figma's UI
  disables "fill container" when the parent hugs that axis; the Plugin API
  accepts it and resolves it to nothing. Combined with the 1px seed introduced
  for dividers, an ordinary `<Frame w="fill" h={20}/>` inside a hug-width parent
  came out **1px wide and invisible**, with no error anywhere. The 1px seed is
  now reserved for dividers (what it was built for), and `render` /
  `render-batch` print an explicit warning naming the child, the parent and the
  axis. The warning is silent for the legitimate case — a divider filling the
  height of a hug-height row, where the text siblings set the height.
- **`minW` / `maxW` / `minH` / `maxH` actually work.** They were in the
  known-prop list but were never emitted — a silent no-op, like `stretch` before
  it. They now apply to root frames, nested frames and text, guarded per
  property so an unsupported node type can't abort a render.

### Fixed — eval

- **`eval` accepts top-level `await`.** CDP runs eval code as a script, where a
  bare `await` (and a bare `return`) is a syntax error, so the daemon wraps the
  code in an async IIFE when needed. It decided that with three regexes that
  only looked for `return` — so top-level `await` was never detected at all, and
  `return` was missed unless it sat at the start or right after a `;`. Both
  `let p = 1\nreturn p` and `if (!p) { return x }` came back as a raw
  "Illegal return statement" from inside Figma. Hand-writing
  `(async () => { … })()` was the documented workaround; it is no longer needed.
  The wrapper now asks the JS engine which form compiles (parse-only, nothing is
  executed) instead of guessing, and prefers the expression form so a bare
  `figma.root.name` — or a bare `await figma.getNodeByIdAsync(id)` — still
  evaluates to the value. Already-wrapped code is left byte-identical.

### Changed

- **The CLI loads only the command you invoked.** All 25 command modules were
  imported on every run, and startup dominated: `eval` took ~149ms end to end,
  of which ~108ms was process start plus module load and only ~40ms the actual
  Figma roundtrip. Startup is now **108ms → 70ms**, so `eval` runs in ~102ms —
  about a third off every command. Anything unrecognised (`--help`, an unknown
  command, no arguments) still loads everything, so help output and "did you
  mean" suggestions stay complete. A few commands forward into another module's
  command (`import` hands DESIGN.md work to `tokens import-design-md`); those
  dependencies are declared, and a test regenerates the map from the real
  Commander tree and fails on a missing command, a wrong module or an undeclared
  forward.
- **`node` and `analyze` stopped shelling out.** `node tree/bindings/to-component/delete`,
  `lint` and `analyze colors/typography/spacing/clusters` each carried TWO
  implementations: a native one used in Safe Mode, and an `npx figma-use` spawn
  used in Yolo Mode — so the mode with the faster CDP connection took the slower
  path, after a `curl` subprocess spawned just to detect the mode. They all run
  the native one now, in both modes: **714ms → 149ms** for `lint`, **684ms →
  148ms** for `to-component` (which runs after every component you create).
- `node tree` prints node ids and caps its output at 400 lines (`--limit`),
  naming how many nodes it dropped. Trees of real files run to thousands of
  lines and usually land in an AI's context.
- `node bindings` reads ALL bindings of a property, not just the first. Figma
  hands back an array for fills/strokes, and only `[0]` was read, so every
  binding after the first was invisible. It also uses the async variable lookup
  (the sync one is deprecated) and resolves each variable id once.
- `node to-component` / `node delete` now name what they skipped and why, and
  exit non-zero instead of reporting a silent success for ids that were never
  there.
- **One render path.** `render` no longer shells out to the `figma-use` binary
  and no longer has a separate fast path; everything goes through `parseJSX`,
  which gained the `-x` / `-y` / `--parent` placement options that previously
  only the external renderer supported. One behaviour to reason about, one place
  to fix, and no process spawn per render: **~2.5× faster** (527ms → 206ms per
  frame, measured over the harness's 10 cases).

### New

- **Browser Mode (`figma-cli connect --browser`).** A connection mode that never
  patches or modifies the local Figma Desktop app. It launches a Chromium-based
  browser (Chrome/Edge/Brave/Chromium) with remote debugging enabled — in a
  dedicated persistent profile so your Figma login survives and your everyday
  browser profile is untouched — waits for you to open a design file, then drives
  it over the exact same CDP path as Yolo Mode (the CDP client already discovers
  the `figma.com/(design|file)` tab, so no other code path changes). For anyone who
  can't or won't modify Figma's signed binary (compliance, no macOS "App
  Management" permission, locked-down machines). Yolo Mode (desktop patch) and Safe
  Mode (plugin) are unchanged.
- **Claude Code plugin + marketplace.** The repo is now installable as a Claude
  Code plugin: `/plugin marketplace add silships/figma-cli` then
  `/plugin install figma-cli@intodesignsystems`. Ships a `figma-cli` skill (the
  condensed operating rules — connect modes, render/JSX, tokens, verify, a11y) so
  Claude Code is fluent with the CLI in any project. Manifests live in
  `.claude-plugin/` (`plugin.json` + `marketplace.json`); the skill lives in
  `skills/figma-cli/`. The CLI itself is unchanged; the plugin only carries the
  know-how (the local Node CLI still does the work).
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
