# figma-ds-cli

<p align="center">
  <a href="https://intodesignsystems.com"><img src="https://img.shields.io/badge/Into_Design_Systems-intodesignsystems.com-ff6b35" alt="Into Design Systems"></a>
  <img src="https://img.shields.io/badge/Figma-Desktop-purple" alt="Figma Desktop">
  <img src="https://img.shields.io/badge/No_API_Key-Required-green" alt="No API Key">
  <img src="https://img.shields.io/badge/No_MCP-Required-green" alt="No MCP Required">
  <img src="https://img.shields.io/badge/No_Rate_Limits-✓-green" alt="No Rate Limits">
  <img src="https://img.shields.io/badge/Works_in-Claude_Code-D97757?logo=claude&logoColor=white" alt="Works in Claude Code">
  <a href="#using-cursor"><img src="https://img.shields.io/badge/Works_in-Cursor-000000?logo=cursor&logoColor=white" alt="Works in Cursor"></a>
</p>

<p align="center">
  <b>Talk in plain English. Watch Figma build.</b><br>
  You describe what you want, an AI assistant builds it live in your Figma Desktop.<br>
  No API key. No copy-paste. No plugin to babysit. No code to write.
</p>

---

## What is this?

figma-ds-cli lets an **AI assistant build directly in your Figma Desktop**, while you talk to it in normal language.

You don't run commands or write code. You open **Claude** in this project and say things like:

> "Create three pricing cards."
> "Use my brand's design system."
> "Make those buttons look like Stripe."
> "Check the contrast on this screen."

Claude does the rest. Figma updates in real time, in front of you.

It works with real, editable Figma , actual frames, components, variants and variables , not a flat image. And it runs **locally**: no API key, nothing sent to a cloud service.

---

## Setup , let your AI do it for you

You don't install this by hand. You use an **AI coding assistant** , **Claude Code** (recommended, what most people use) or **Cursor** , point it at this project, and ask it to set everything up.

> **Using Cursor?** Jump to [Using Cursor](#using-cursor) for the one-line setup. The steps below are for Claude Code; everything the CLI does is identical in both.

### 1. Have these ready
- **Figma Desktop** , installed and open ([download](https://www.figma.com/downloads/)).
- **Claude Code** , Anthropic's AI assistant for your computer. [Install it here](https://docs.claude.com/en/docs/claude-code) (one command, takes a minute). *(Or use Cursor , see below.)*

### 2. Get this project onto your computer
Don't know git? No problem. Open Claude Code anywhere and paste:

> "Download the figma-cli project from https://github.com/silships/figma-cli into a folder in my home directory, then go into it."

(Or, if you prefer: click the green **Code** button on the GitHub page → **Download ZIP** → unzip it.)

### 3. Let Claude install and connect it
Open Claude Code **inside the project folder** and say:

> "Set up figma-cli and connect it to my Figma."

Claude reads the project's instructions, installs what's needed, and connects to your open Figma Desktop. You watch , you don't type commands.

When it says it's connected, you're done. ✅

### 4. Start designing , just talk
Now describe what you want:

> "Add my brand colors, then create a primary button and a secondary button."

Claude builds it in Figma instantly.

---

## Using Cursor

Prefer **Cursor**? It works exactly the same , the CLI controls Figma Desktop, not your editor, so nothing about it is Claude-only. Most people use Claude Code, but if Cursor is your tool, here's the whole setup.

### 1. Have these ready
- **Figma Desktop** , installed and open ([download](https://www.figma.com/downloads/)).
- **Cursor** , [download here](https://cursor.com).

### 2. Tell Cursor to install it , one line
Open Cursor in any folder, open the chat (the Agent), and paste:

> **"Install github.com/silships/figma-cli and connect it to my Figma."**

Cursor downloads the project, installs it, sets up its own rules so it knows how to drive it, and connects to your open Figma Desktop. You watch , you don't type commands.

> Under the hood Cursor runs one extra command for itself , `figma-cli init-agent` , which drops a small `.cursor/rules/figma-cli.mdc` into your project. That's the file that teaches Cursor's Agent the rules (use real variables, wrap text properly, build N items as N components, etc.). You never edit it.

When it says it's connected, you're done. ✅

### 3. Start designing , just talk
Same as Claude Code , describe what you want:

> "Add my brand colors, then create a primary button and a secondary button."

Cursor builds it in Figma instantly.

**Already set up in a project and just want the Cursor rules?** Run `figma-cli init-agent` yourself , it writes the Cursor rules **and** an `AGENTS.md` (which Claude Code and Cursor both read), without touching any existing `CLAUDE.md`.

---

## How it connects to Figma: Yolo vs Safe mode

figma-ds-cli talks to your Figma Desktop in one of two ways. Claude picks one during setup , here's what they mean, so you know what's happening:

### ⚡ Yolo Mode , the default, recommended
- **Fully automatic.** Claude sets it up, you do nothing.
- It applies a **small, reversible patch** to the Figma Desktop app so the CLI can talk to it directly. That's what makes it fast and completely hands-off , no plugin to keep open, no clicking.
- "Yolo" sounds scary, but it's **safe and undoable** , Claude can un-patch it anytime, and nothing ever leaves your machine.
- Just tell Claude *"connect to Figma"* and you're done.

### 🛡️ Safe Mode , no changes to the Figma app
- **Doesn't touch the Figma app at all.** Instead it uses a tiny built-in Figma plugin.
- You run it once from Figma's **Plugins → Development → FigCli** and keep that plugin open while you work.
- A little more manual (you start the plugin), but **zero modifications** to Figma itself , good if you, or your company's IT policy, don't want the app patched.
- Tell Claude *"connect to Figma in safe mode"*.

**Both do exactly the same things.** Unsure? Use Yolo. Want nothing changed on your Figma app? Use Safe. You can switch anytime , just ask Claude.

---

## figma-cli vs the MCP servers (the question I get asked most)

People keep asking how figma-cli differs from **Figma's official MCP** and from **figma-console-mcp**. Short version: they talk to Figma through the **cloud REST API**, figma-cli talks to **Figma Desktop directly on your machine**. That one architectural choice changes everything downstream.

| | **figma-cli** | Figma official MCP / figma-console-mcp |
|---|---|---|
| **How it connects** | CDP → your local Figma Desktop | Figma REST API (cloud) |
| **Figma token** | not needed | required (`figd_…`) |
| **Figma rate limit** | **none** — there are no API calls to throttle | yes — can bottleneck heavy automation / AI on Free or Starter plans |
| **Works offline** | yes | no |
| **Setup** | one `connect` command | token + plugin/bridge + (for some) port wrangling |

### Why "no rate limit" is a real, structural advantage
Figma's APIs are rate-limited, and on Free or Starter plans those limits can become a bottleneck for large-scale automation or AI workflows. Any tool built on that API — Figma's own MCP included — runs into the same ceiling. figma-cli sidesteps it entirely because it never calls the API: it drives Figma Desktop locally over CDP.

### The quieter advantage: it costs your AI far fewer tokens
figma-cli's commands are terse and there are **no large tool schemas loaded into the AI's context**. Driving an MCP server, by contrast, loads its instructions + dozens of tool schemas and returns verbose JSON. Measured like-for-like in one session (tokens ≈ bytes ÷ 4, approximate):

| Task | figma-cli | API-based MCP |
|---|---:|---:|
| Cold start → first component | **~140 tok** | ~1,600 tok (**~11×**) |
| Generate one token-bound component | **~68 tok** | ~256–556 tok (**~4–8×**) |

On a fixed AI plan (e.g. Claude Pro), fewer tokens per task means you get more done before hitting *your AI's* usage limits too — and a leaner context means the AI keeps its facts straight instead of "forgetting" node IDs as the window fills.

**Bottom line:** local, no token, no rate limit, no cloud round-trip, and the lowest token cost — built for fast, reliable building and verifying from Claude Code or Cursor.

---

## What you can ask for

Just say it in plain language. A few examples:

**Build things**
- "Create 5 pricing cards in a row."
- "Make a login form."
- "Build a dashboard layout."
- "Add a dialog / a calendar / a sidebar." *(40+ shadcn/ui components available)*

**Use a design system**
- "Add shadcn colors" or "add Tailwind colors."
- "Make these in Stripe's style" / "use the Linear design system."
- "Use my brand's variables on these cards."

**Bring your own brand**
- "Import this design system" *(point it at a `DESIGN.md` file , see below)*
- "Switch this design from Stripe to Apple." *(swap a whole layout between brands)*
- "Export this file's design system as markdown." *(any open file → `DESIGN.md` , see below)*

**Polish & hand off**
- "Check the color contrast / touch targets / text sizes."
- "Export this as PNG / SVG."
- "Turn this into a reusable component with Small / Medium / Large variants."

You never memorize commands. Claude knows them , you just describe the outcome.

---

## Bring your own design system

Have a brand or a design system? Put it in a single `DESIGN.md` file (colors, type, spacing) and tell Claude:

> "Import ~/Downloads/my-DESIGN.md into Figma."

It creates real Figma variables (`primary`, `canvas`, `ink`, `accent`, …) you can use everywhere , and you can switch a design between systems on demand ("now make it look like Vercel"). Ready-made `DESIGN.md` files for popular brands work too.

DESIGN.md is no longer the only way in. You can point `figma-cli import` directly at the source files your project already has:

- **Tailwind config** (`tailwind.config.js`) , colors, radii, spacing and font families land as Figma variables.
- **CSS custom properties** (`globals.css`, `styles.css`) , supports shadcn HSL triples, Tailwind v4 `@theme` blocks and oklch.
- **Design-tokens JSON** (`tokens.json`) , W3C design-tokens format and Style Dictionary files, including alias resolution.
- **Storybook** (`http://localhost:6006` or `./storybook-static/`) , imports your component inventory (names, variants) as context for the AI. Combine with a Tailwind or CSS import to get design tokens too.

Ask Claude: "Import my tailwind config" or "load our storybook at localhost:6006" and it handles the rest.

---

## Export any Figma file as DESIGN.md

The reverse also works. Open any Figma file , yours, a client's, a Community file like GitHub's Primer , and say:

> "Export the design system as markdown."

figma-ds-cli scans **every page** (no truncation, even on 100k+ node files) and writes a `DESIGN.md` with the full token map: colors ranked by usage, the type scale, spacing, radii, shadows, plus a variant matrix for every component set (e.g. Button: variant × size × state, with all values). The file round-trips , `figma-cli import` reads it back into variables in any other file.

Components aren't just documented, they're addressable: `figma-cli spec "Button"` reads the markdown in code (zero model tokens) and returns just that one component's spec plus its reuse handle, so an agent pulls in exactly what it needs on demand instead of loading the whole file.

What it's for:

- **Feed your design system to AI tools** , Claude, Cursor, Copilot read DESIGN.md and build UI that actually matches your Figma file
- **Reuse, don't rebuild** , every component in the exported DESIGN.md carries a *reuse handle*. Ask for a component that already exists and the AI drops a real instance of it (`figma-cli instantiate "Button"`) instead of cloning a one-off copy, so your file stays consistent with the source system
- **Document a design system** , one command instead of hand-written token tables
- **Transfer tokens between files** , extract from file A, import into file B
- **Learn from Community files** , extract Primer, Material or any public system and see exactly how it's built

Huge files stay usable: when the structure trees alone would blow an AI context window, they're split into per-page files automatically and the main DESIGN.md stays small enough to load whole (Primer Web: 67 pages, 124k nodes → a 35k-token main file).

---

## Works offline / with local AI

Prefer to keep everything on your machine? figma-ds-cli also works with **local LLMs** (via LM Studio or Ollama) , fully offline, no cloud, no key. Ask Claude to "set up the local LLM agent" and it'll walk you through it.

---

## Everything it can do

**40+ ready components · 30+ capabilities · 8 areas.** You trigger any of these just by asking.

**🧩 Components (40+ components + 3 tools)**
- 40+ shadcn/ui components (buttons, cards, inputs, dialogs, tabs, calendar, sidebar, …) with real Lucide icons
- Turn anything into a reusable **component** with **variants** (Size, State, …)
- Build **slots** for flexible, composable components
- Combine existing frames into a variant set

**🎨 Design systems & tokens (4)**
- One-command presets: **shadcn** (Light/Dark) and **Tailwind** color scales
- **Import your own brand** from a `DESIGN.md` , colors, typography, radius become real Figma variables
- **Switch a design between brands** (Stripe → Apple → your brand) , token names stay consistent
- Visualize a whole palette on the canvas

**🖼️ Visuals & effects (5)**
- Drop shadows, inner shadows, layer & background blur, glassmorphism
- Linear, radial, angular & diamond **gradients**
- **Extract a gradient from any image** , get a Figma-ready fill or a mesh wallpaper
- Generate **mesh-gradient wallpapers** from a color palette
- Image fills from any URL, corner smoothing (iOS squircles), rotation, blend modes

**📐 Layout & structure (4)**
- Real auto-layout (flex rows/columns, fill/hug, gaps, alignment)
- Pre-built **blocks** (full dashboards, page layouts) in one step
- Precise absolute positioning (pin to corners, center, stretch)
- Sections and layout grids to organize the canvas

**♿ Accessibility (4)**
- Contrast checking (WCAG)
- Touch-target sizing, text-size checks
- Color-blindness simulation
- One-shot full a11y audit

**📦 Handoff & export (4)**
- Export **PNG, SVG, JSX**, Storybook stories, CSS variables, Tailwind config, and **DTCG / W3C design-tokens JSON** , so tokens round-trip both ways (import *and* export)
- Link components to **Storybook / GitHub / docs**
- Inline **annotations** for usage rules and token references
- Recreate a live webpage in Figma from a URL

**🤖 Built for AI (6)**
- Works with **Claude Code** or **Cursor** , one `figma-cli init-agent` sets up the rules for both
- Works with **Claude**, or local LLMs via **LM Studio / Ollama** (fully offline)
- Ships the entire **Figma Plugin API spec offline** so the AI can self-discover
- Self-corrects when a command needs a different approach
- Screenshot-based verification (`verify --measure`) so the AI checks its own work by numbers
- Enforces a **DESIGN.md spec** when recreating components (`spec --check`) , no eyeballing
- Optional **voice control** (macOS): "create three pricing cards" out loud

**🔒 No strings (2)**
- No API key, no cloud roundtrip, no plugin store waits
- Talks to Figma Desktop directly , real, editable Figma every time

---

## For developers

Everything above is powered by a CLI that the AI calls for you. If you want to use it directly, script it, or see every command:

- **[REFERENCE.md](REFERENCE.md)** , full command reference (tokens, render/JSX, components, gradients, a11y, export, the offline Figma API spec, and more).
- Two connection modes: **Yolo** (direct, recommended) and **Safe** (plugin-based, no patching). Claude picks the right one during setup.

You don't need any of this to use the tool , it's here for tinkerers.

---

## Why this exists

Figma plugins are slow to build and tied to one UI. AI assistants are great at *describing intent* but need a clean way to act on Figma. figma-ds-cli is the bridge: it talks to Figma Desktop directly, so you can design by conversation , locally, with no API key and no cloud roundtrip.

**You design. The AI builds. Figma updates.**

---

## License

MIT. Built by [Sil Bormüller](https://intodesignsystems.com).
