# figma-ds-cli

<p align="center">
  <a href="https://intodesignsystems.com"><img src="https://img.shields.io/badge/Into_Design_Systems-intodesignsystems.com-ff6b35" alt="Into Design Systems"></a>
  <img src="https://img.shields.io/badge/Figma-Desktop-purple" alt="Figma Desktop">
  <img src="https://img.shields.io/badge/No_API_Key-Required-green" alt="No API Key">
  <img src="https://img.shields.io/badge/AI--Ready-Local%20%2B%20Cloud%20LLMs-blue" alt="AI Ready">
  <img src="https://img.shields.io/badge/DESIGN.md-Import-orange" alt="DESIGN.md Import">
</p>

<p align="center">
  <b>Talk to your AI. Watch Figma build.</b><br>
  Connect Claude Code, opencode, Cursor, or a local LLM directly to Figma Desktop.<br>
  No API key. No copy-paste. No plugin you have to babysit.
</p>

---

## ⭐ Import a whole design system in one command

Drop a `DESIGN.md` onto the CLI and figma-cli ingests the entire thing — colors, radii, typography — and creates Figma variables you can immediately use in renders.

```bash
figma-cli import ~/Downloads/DESIGN.md
```

**Two formats supported, auto-detected:**

1. **YAML frontmatter** — top-level `colors:`, `typography:`, `rounded:` / `radius:`, `spacing:` (the Stitch / getdesign.md style — drop in any of the ready-made `DESIGN.md` files from public collections)
2. **JSON token block** — the `## Machine-readable tokens` + `` ```json design-tokens `` extraction format (Carbon, Material, Polaris, in-house exporters)

No personal access token. No cloud. Drops straight into Figma Desktop via the local daemon.

After import, every render uses `var:primary`, `var:canvas`, `var:radius-md` etc. — the names from your DESIGN.md. Mix this with the local LLM agent (see `figmachat` / `/load`) and the model uses your token vocabulary automatically.

[See full DESIGN.md docs →](#import-a-design-system-from-a-designmd)

---

## What you can do

You say it in plain English. The AI translates it into figma-cli calls. Figma updates instantly.

**Design systems**
- Spin up shadcn/ui components (41 visual + 5 interactive-only, with real Lucide icons)
- Generate design tokens — shadcn, Tailwind, custom — bound to Light/Dark modes
- **Import a whole design system from a `DESIGN.md` extraction file** (see below)
- Build component sets with variants (`Size=Small`, `Size=Medium`, ...)
- Link components to Storybook, GitHub, or internal docs
- Add inline annotations to document usage rules and token references

**Visual richness**
- Drop shadows, inner shadows, layer/background blur
- Linear, radial, angular, diamond gradients
- Image fills from any URL
- Layout grids (12-column, baseline, custom)
- Sections to organize the canvas

**Production-ready output**
- Export PNG, SVG, JSX, Storybook stories, CSS variables, Tailwind config
- Accessibility audit: contrast, touch targets, text size
- Verify component creation with screenshot-based AI checks

**Built for AI workflows**
- Offline Figma Plugin API reference (`figma-cli api setup`) — agents read the spec themselves
- Auto-suggests interface references when commands fail — agents self-correct
- Same CLI works with Claude Code, opencode, Cursor, or a local LLM via LM Studio / Ollama

**Voice control (optional)**
- Push-to-talk: say "create three pricing cards", figma-cli does it
- macOS only, requires an Anthropic API key
- `figma-cli plugins install voice && figma-cli plugins setup voice && figma-cli voice`

---

## Quick start

```bash
# 1. Install dependencies and link binary
git clone https://github.com/silships/figma-cli.git
cd figma-cli
npm install

# 2. Connect to Figma
node src/index.js connect          # Yolo Mode (recommended)
# Or: node src/index.js connect --safe   (plugin-based, no patching)

# 3. Open your AI tool of choice and tell it about figma-cli.
#    Claude Code, opencode, cursor — anything that can run shell commands.
```

That's it. Tell your AI:

> *"Add shadcn colors, then create a primary button with a soft drop shadow."*

The AI translates that into figma-cli commands. Figma renders the result in real-time.

---

## Run a local LLM (offline-friendly)

figma-cli has zero opinion about which LLM you use. Point any LM-Studio-compatible model at it (`localhost:1234/v1`) via your AI harness. We've tested:

- **Qwen 3.6 35B-A3B** (writer, ~26 tok/s on M4 Max) — good for content and figma-cli command mapping
- **Qwen 3 Coder 30B-A3B** (LoRA-finetuned on figma-cli) — tighter tool use
- **GPT-OSS 20B** (smaller, faster) — solid alternative

Setup: install LM Studio, pull the model, start the local server. Your AI harness reads `OPENAI_BASE_URL=http://localhost:1234/v1`. figma-cli does not need to know — it just receives shell commands from whatever's driving it.

If your local LLM gets a command wrong, figma-cli surfaces relevant Figma Plugin API references after the error. The LLM reads the suggestion, looks up the spec, retries:

```
✗ Error: in addComponentProperty: Default value for instance swap component property is invalid

  💡 Looks like this might map to a Figma Plugin API. Try:
    figma-cli api ComponentNode (defines "addComponentProperty")
    figma-cli api ComponentPropertiesMixin (defines "addComponentProperty")
```

Run `figma-cli api setup` once (5 MB download) to enable this. Works offline forever after.

---

## Import a design system from a DESIGN.md

If you (or a teammate) extracted a Figma file into a `DESIGN.md` — using any tool that emits the standard format with a `## 11. Machine-readable tokens` section and a `` ```json design-tokens `` code block at the end — figma-cli can ingest it directly:

```bash
figma-cli import /path/to/DESIGN.md
```

(Same thing under the hood: `figma-cli tokens import-design-md /path/to/DESIGN.md`. The short form auto-detects the format.)

This creates Figma variables for every color, radius, and typography token defined in the JSON block. The collection is named after the system's `meta.source` (e.g. "Carbon Design System", "Material 3", "Polaris") unless you pass `-c <name>`.

**Expected JSON shape** (any DESIGN.md following the same convention works — this is format-agnostic, not Carbon-specific):

```json
{
  "meta": { "source": "Your Design System", "generated": "2026-01-01" },
  "color":      { "accent": "#0f62fe", "text-primary": "#161616", ... },
  "radius":     { "radius-md": 2, "radius-lg": 8, ... },
  "typography": { "h1": { "fontFamily": "Inter", "fontSize": 70, ... }, ... },
  "shadow":     { "elev-1": "0 1px 2px rgba(0,0,0,0.05)", ... },
  "fonts":      ["Inter", "IBM Plex Sans", ...]
}
```

**For local LLM agents** — also drop the same file into `figmachat` with `/design /path/to/DESIGN.md`. The agent learns your token names and existing component vocabulary, so future renders use `bg="var:accent"` instead of `bg="#0f62fe"` and reference your existing Button / Card / etc. instead of generating duplicates.

Preview the agent context without touching variables:
```bash
figma-cli tokens import-design-md /path/to/DESIGN.md --print-context
```

---

## Absolute positioning, done right

figma-cli implements the [directededges Absolute Positioning spec](https://directededges.github.io/specs/guides/absolute-positioning/) — designers and code platforms agree about edges and centers, but Figma's API forces you to convert manually between raw `x` / `y` and the `constraints` object. figma-cli does the math for you AND sets the matching constraint, so elements stay anchored when the parent resizes.

**Pin existing nodes by edge:**

```bash
# Modal close button — 16px from top-right of its parent
figma-cli pin top-right --offset-x 16 --offset-y 16 --node 5:42

# Bottom-of-screen toast — stretched across parent, 24px from bottom
figma-cli pin stretch-x --start 16 --end 16 --node 5:43
figma-cli pin bottom --offset 24 --node 5:43

# Center horizontally, scale to 25% / 25% margins
figma-cli pin scale-x --start "25%" --end "25%" --node 5:44
```

Edges: `left`, `right`, `top`, `bottom`, `top-left`, `top-right`, `bottom-left`, `bottom-right`, `center-x`, `center-y`, `stretch-x`, `stretch-y`, `scale-x`, `scale-y`.

**Or use edge-relative attributes when rendering new elements:**

```jsx
figma-cli render '<Frame name="Modal" w={400} h={300} bg="#fff">
  <Frame name="CloseBtn" position="absolute" top={12} right={12} w={24} h={24} />
  <Frame name="Overlay" position="absolute" top={0} bottom={0} left={0} right={0} bg="#0008" />
</Frame>'
```

`top` / `right` / `bottom` / `left` work like CSS. Opposite edges together = STRETCH. Percentage strings (`"25%"`) = SCALE. `centerOffsetX` / `centerOffsetY` = CENTER with offset.

**Read it back, get spec-canonical JSON:**

```bash
figma-cli inspect 5:42 --json
# {
#   "id": "5:42", "name": "CloseBtn", "type": "FRAME",
#   "absolutePositioning": {
#     "position": "ABSOLUTE",
#     "top": 12, "right": 16, "width": 24, "height": 24,
#     "bottom": null, "start": null, "end": null,
#     "centerHorizontalOffset": null, "centerVerticalOffset": null
#   }
# }
```

---

## Two connection modes

Both modes have full feature parity. Pick based on permissions.

| Mode | Command | Use when |
|---|---|---|
| **Yolo** | `figma-cli connect` | Personal Mac, fastest path. Patches Figma once for direct CDP access. |
| **Safe** | `figma-cli connect --safe` | Corporate laptop. No patching. Uses a small Figma plugin instead. |

**Safe Mode setup (one-time):**
1. `figma-cli connect --safe`
2. In Figma: **Plugins → Development → Import plugin from manifest** → select `plugin/manifest.json`
3. Each session: **Plugins → Development → FigCli** to start the plugin

---

## What's in the API surface

The full command reference lives in [REFERENCE.md](REFERENCE.md). Designers don't need to memorize it — your AI tool does the lookup.

Categories:
- **Tokens** — `tokens preset shadcn`, `tokens tailwind`, `tokens import`, `var create/list/delete-all`, `col list`
- **Components** — `shadcn add`, `combos`, `sizes`, `node to-component`, `component prop`, `component combine`
- **Render** — `render` (JSX), `render-batch` (multiple frames in one call), `blocks create`
- **Visuals** — JSX props: `shadow`, `innerShadow`, `blur`, `bgBlur`, `bg="linear-gradient(...)"`, `image`, `imageScale`
- **Organization** — `section create/list/add`, `grid set/list/clear`
- **Docs & Handoff** — `dev link/list/unlink`, `annotate add/list/clear`
- **A11y** — `a11y contrast`, `a11y audit`, `a11y touch`, `a11y vision`, `a11y text`
- **Inspection** — `canvas info`, `node tree`, `find`, `verify`
- **Export** — `export png`, `export svg`, `export jsx`
- **API reference** — `api setup`, `api list`, `api <Name>`, `api gap`

---

## Why this exists

Figma plugins are slow to write, slow to ship, and tied to a single UI. AI tools want a structured API they can call programmatically.

figma-cli sits between them:
- Talks to Figma Desktop directly (via CDP in Yolo, via plugin in Safe Mode)
- Exposes a clean CLI that's easy for any AI tool to invoke
- Ships with the full Figma Plugin API spec offline, so LLMs can self-discover
- Stays out of your way — no API keys, no cloud roundtrip, no plugin store waits

You design. The AI types. Figma updates.

---

## License

MIT. Built by [Sil Bormüller](https://intodesignsystems.com).
