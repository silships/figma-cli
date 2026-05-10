# figma-ds-cli

<p align="center">
  <a href="https://intodesignsystems.com"><img src="https://img.shields.io/badge/Into_Design_Systems-intodesignsystems.com-ff6b35" alt="Into Design Systems"></a>
  <img src="https://img.shields.io/badge/Figma-Desktop-purple" alt="Figma Desktop">
  <img src="https://img.shields.io/badge/No_API_Key-Required-green" alt="No API Key">
  <img src="https://img.shields.io/badge/AI--Ready-Local%20%2B%20Cloud%20LLMs-blue" alt="AI Ready">
</p>

<p align="center">
  <b>Talk to your AI. Watch Figma build.</b><br>
  Connect Claude Code, opencode, Cursor, or a local LLM directly to Figma Desktop.<br>
  No API key. No copy-paste. No plugin you have to babysit.
</p>

---

## What you can do

You say it in plain English. The AI translates it into figma-cli calls. Figma updates instantly.

**Design systems**
- Spin up shadcn/ui components (all 30, with real Lucide icons)
- Generate design tokens — shadcn, Tailwind, custom — bound to Light/Dark modes
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
