---
name: figma-cli
description: Build and edit designs directly in Figma Desktop from the terminal using the figma-cli command (controls Figma live over a local connection, no API key). Use whenever the user wants to create, render, or edit Figma frames/components/variants, add or import design tokens/variables (shadcn, Tailwind, DTCG, CSS), extract a design system to DESIGN.md, generate gradients/wallpapers, animate with Figma Motion, run accessibility audits, or connect an AI assistant to their Figma. Triggers on "build/make X in Figma", "add my design system", "create N buttons/cards", "use my variables", "export the design system", "check contrast".
---

# Using figma-cli

figma-cli controls **Figma Desktop** directly (no API key). It runs in any
terminal. Open Figma Desktop, then `figma-cli connect` once per session.

If the `figma-cli` command is not found, the tool isn't installed yet — see
**Installation** at the bottom. Never show raw terminal commands to the user;
run them silently and give friendly feedback.

## Connect (pick one mode, offer them in this order)
- `figma-cli connect --browser` — **Browser (recommended)**: drives Figma in a Chromium
  browser via a local connection; **never modifies the Figma app**. Tell the designer
  BEFORE running it: "A Chrome window opens in a moment. Sign in to Figma there and open
  a design file. I connect by myself as soon as it is open."
- `figma-cli connect` — **Yolo**: for the Figma Desktop app, patches it once, fully automatic.
- `figma-cli connect --safe` — **Safe**: official plugin (Plugins → Development → FigCli).

## Golden rules
1. **Create frames with `render` / `render-batch`** — they have smart positioning.
   NEVER use `eval` to create visual nodes (no positioning, bypasses guards).
2. **"N buttons/cards" = N separate top-level nodes**, not one wrapper frame
   containing N children. Use `render-batch '[...]'` or `shadcn add <c> --count N`.
3. **Never delete the user's existing nodes.**
4. After creating, **verify**: `figma-cli verify "<id>" --measure` (returns a
   screenshot + real w/h so you catch size bugs by numbers, not by eye).

## Design tokens / variables
- Bind colors at creation with `var:name`, never raw hex when a system is loaded:
  `<Frame bg="var:primary"><Text color="var:on-primary">Go</Text></Frame>`
- Pin a named collection when the user names one: `render-batch ... --collection figma`.
- Import a system: `figma-cli import tailwind.config.js | globals.css | tokens.json`.
- Export the open file's system: `figma-cli extract` → DESIGN.md.

## JSX cheatsheet (render)
- Layout: `flex="row|col" gap={16} p={24} px py pt pr pb pl justify="center|between" items="center"`
- Size: `w={320} h={200} w="fill" w="hug" w="60%"` (percent resolves vs parent)
- Look: `bg="#fff" stroke="#000" strokeWidth={2} rounded={12} shadow="..." opacity={0.8}`
- Text: `<Text size={14} weight="semibold" color="#000" lineHeight={20} truncate maxLines={2} w="fill">`
- Icons (real SVG, never emojis): `<Icon name="lucide:home" size={20} color="var:primary" />`
- Dividers: a thin child (`<Frame w={1} bg="var:border" />`) auto-fills the cross axis.

## Text wrapping (most common bug)
For text to wrap, the parent AND every `<Text>` need `w="fill"`, and the parent
needs `flex="col"` or `flex="row"`.

## Recreating a component from an extracted DESIGN.md (hard rule)
Don't read the structure markdown by hand. Use:
- `figma-cli spec <Component>` → authoritative variant axes + sample size (compact).
  Build EXACTLY to those axes (e.g. Variant × Size = a Component Set, not one node).
- `figma-cli spec <Component> --check <nodeId>` → enforces it (exit 1 on mismatch:
  wrong structure, missing axes, wrong height). Treat non-zero as "not done".

## Handy commands
```
figma-cli connect --browser            # connect to Figma in Chrome (recommended)
figma-cli connect                      # connect to Figma Desktop (yolo)
figma-cli render '<Frame>...</Frame>'  # one frame
figma-cli render-batch '[ "<Frame>", ... ]' --direction row
figma-cli shadcn add button --count 3  # N distinct shadcn primitives
figma-cli node to-component "<id>"     # promote to a component
figma-cli verify "<id>" --measure      # screenshot + dimensions
figma-cli a11y audit                   # contrast / touch / text checks
figma-cli tokens preset shadcn         # 244 primitives + semantic (light/dark)
figma-cli var visualize                # show colors on canvas
figma-cli motion preset <id> fade-up   # animate (Figma Motion, beta)
figma-cli blocks create dashboard-01   # pre-built dashboard layout
```

## Installation
figma-cli is a Node CLI (Node ≥ 18) that talks to Figma Desktop locally. If the
`figma-cli` binary is missing, get the project from
https://github.com/silships/figma-cli and run `npm install` in it, then invoke it
as `node src/index.js <command>` (or link it as `figma-cli`). Full command
reference and JSX docs live in that repo's README.md and REFERENCE.md.
