# figma-ds-cli

<p align="center">
  <a href="https://intodesignsystems.com"><img src="https://img.shields.io/badge/Into_Design_Systems-intodesignsystems.com-ff6b35" alt="Into Design Systems"></a>
  <img src="https://img.shields.io/badge/Figma-Desktop-purple" alt="Figma Desktop">
  <img src="https://img.shields.io/badge/No_API_Key-Required-green" alt="No API Key">
  <img src="https://img.shields.io/badge/Claude_Code-Ready-blue" alt="Claude Code">
</p>

<p align="center">
  <b>Control Figma Desktop with Claude Code.</b><br>
  Full read/write access. No API key required.<br>
  Just talk to Claude about your designs.
</p>

```
  ███████╗██╗ ██████╗ ███╗   ███╗ █████╗       ██████╗ ███████╗       ██████╗██╗     ██╗
  ██╔════╝██║██╔════╝ ████╗ ████║██╔══██╗      ██╔══██╗██╔════╝      ██╔════╝██║     ██║
  █████╗  ██║██║  ███╗██╔████╔██║███████║█████╗██║  ██║███████╗█████╗██║     ██║     ██║
  ██╔══╝  ██║██║   ██║██║╚██╔╝██║██╔══██║╚════╝██║  ██║╚════██║╚════╝██║     ██║     ██║
  ██║     ██║╚██████╔╝██║ ╚═╝ ██║██║  ██║      ██████╔╝███████║      ╚██████╗███████╗██║
  ╚═╝     ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝      ╚═════╝ ╚══════╝       ╚═════╝╚══════╝╚═╝
```

## What is This?

A CLI that connects directly to Figma Desktop and gives you complete control:

- **shadcn/ui Components** — Generate all 30 official shadcn components with real Lucide icons and variable binding
- **Design Tokens** — Create variables, collections, modes (Light/Dark), bind to nodes
- **Create Anything** — Frames, text, shapes, icons (150k+ from Iconify), components
- **Slots** — Create and manage Figma's new Slots feature for flexible component content
- **Team Libraries** — Import and use components, styles, variables from any library
- **Analyze Designs** — Colors, typography, spacing, find repeated patterns
- **Lint & Accessibility** — Contrast checker, touch targets, design rules
- **Export** — PNG, SVG, JSX, Storybook stories, CSS variables, Tailwind config
- **Batch Operations** — Rename layers, find/replace text, create 100 variables at once
- **Works with Claude Code** — Just ask in natural language, Claude knows all commands

---

## shadcn/ui Component Package

Generate production-ready shadcn/ui components directly in Figma. All 30 components with 58 variants, matching the official shadcn/ui specs.

### Quick Start

```bash
# 1. Add shadcn design tokens (Light/Dark mode)
node src/index.js tokens preset shadcn

# 2. Generate all components
node src/index.js shadcn add --all

# Or pick specific ones
node src/index.js shadcn add button card input tabs

# List available components
node src/index.js shadcn list
```

### What You Get

**30 components, 58 variants:**

| Component | Variants |
|-----------|----------|
| Button | Default, Secondary, Destructive, Outline, Ghost, Link, Small, Large, Icon |
| Badge | Default, Secondary, Destructive, Outline |
| Card | Full card with Header, Content, Footer |
| Input | Default, Filled, With Label |
| Textarea | Default |
| Label | Default |
| Alert | Default (info icon), Destructive (alert icon) |
| Avatar | Default, Small |
| Switch | On, Off |
| Separator | Horizontal, Vertical |
| Skeleton | Text, Circle, Card |
| Progress | 60%, 30% |
| Toggle | Default, Active |
| Checkbox | Unchecked, Checked (with check icon) |
| Tabs | Full tabs with content panel |
| Table | Header + 3 rows |
| Radio Group | Unchecked, Checked, Full group |
| Select | Closed, Filled, Open (with dropdown + check icon) |
| Slider | With thumb |
| Breadcrumb | With chevron separators |
| Pagination | With chevron + ellipsis icons |
| Kbd | Single key, Key combo |
| Spinner | Small, Medium |
| Tooltip | Tooltip + trigger |
| Dialog | With close button, form fields |
| Dropdown Menu | With items + separator |
| Accordion | Open + collapsed items |
| Navigation Menu | Active + inactive items |
| Sheet | Side panel with form |
| Hover Card | Profile card |

### Real Lucide Icons

Components use actual Lucide SVG icons (not placeholder shapes), fetched from the Iconify API and rendered as vector nodes in Figma:

- **Pagination**: chevron-left, chevron-right, ellipsis
- **Select**: chevron-down, chevron-up, check
- **Accordion**: chevron-down, chevron-right
- **Checkbox**: check
- **Dialog/Sheet**: x (close button)
- **Alert**: info, alert-circle
- **Button/Icon**: plus
- **Toggle**: bold
- **Breadcrumb**: chevron-right
- **Navigation Menu**: chevron-down

### Design Token Integration

All components use `var:` syntax to bind directly to shadcn variables. When you add tokens with `tokens preset shadcn`, components automatically use your Light/Dark mode colors:

- `background`, `foreground` — page background/text
- `card`, `card-foreground` — card backgrounds
- `primary`, `primary-foreground` — buttons, accents
- `secondary`, `secondary-foreground` — secondary actions
- `muted`, `muted-foreground` — subtle text, disabled states
- `accent`, `accent-foreground` — hover states
- `destructive`, `destructive-foreground` — error states
- `border`, `input`, `ring` — borders, inputs, focus rings

---

## Why This CLI?

This project includes a `CLAUDE.md` file that Claude reads automatically. It contains:

- All available commands and their syntax
- Best practices (e.g., "use `render` for text-heavy designs")
- Common requests mapped to solutions

**Want to teach Claude new tricks?** Just update `CLAUDE.md`. No code changes needed.

**Example:** You type "Create Tailwind colors" -> Claude already knows to run `node src/index.js tokens tailwind` because it's documented in `CLAUDE.md`.

---

## What You Need

- **Node.js 18+** — `brew install node` (or [download](https://nodejs.org/))
- **Figma Desktop** (free account works)
- **Claude Code** ([get it here](https://www.anthropic.com/claude-code))
- **macOS or Windows**
- **Linux:** unofficial `figma-linux` package installed via `apt` only
- **macOS Full Disk Access** for Terminal (Yolo Mode only -- not needed for [Safe Mode](#-safe-mode--for-restricted-environments))

**Linux note:** Linux support is limited to the unofficial `figma-linux` desktop package installed outside Snap. Snap installs are not supported.

---

## Setup

```bash
git clone https://github.com/silships/figma-cli.git
cd figma-cli
npm install
npm run setup-alias
source ~/.zshrc  # or ~/.bashrc
```

That's it. Now open a **new terminal** and type:

```bash
fig-start
```

This will:
1. Start Figma (if not running)
2. Connect to Figma (Yolo Mode: patches Figma once for direct access)
3. Show your open Figma files: pick one with arrow keys
4. Launch Claude Code with all commands pre-loaded

**Done.** Talk to Claude about your Figma file.

> **Note:** `fig-start` works from any directory. The setup script saves the repo location to `~/.figma-cli/config.json`.

### fig-start Options

| Command | Description |
|---------|-------------|
| `fig-start` | Yolo Mode (default), interactive file picker |
| `fig-start --safe` | Safe Mode (plugin-based, no patching) |
| `fig-start --setup` | Change the figma-cli repo path |

### Safe Mode (no patching)

If you can't grant Full Disk Access or prefer not to patch Figma:

```bash
fig-start --safe
```

This uses a Figma plugin instead of patching. See [Safe Mode](#-safe-mode--for-restricted-environments) for details.

### Manual Setup (without fig-start)

```bash
cd figma-cli
claude
```

Then tell Claude: `Connect to Figma`

---

## Using It

Once connected, just talk to Claude:

> "Add shadcn colors to my project"

> "Add all shadcn components"

> "Add a card component with button and input"

> "Check accessibility"

> "Export variables as CSS"

The included `CLAUDE.md` teaches Claude all commands automatically. No manual required.

**Safe Mode users:** Start the FigCli plugin each time you open Figma.

---

## JSX Rendering with Icons

The CLI includes a JSX-like syntax for creating complex layouts. Icons are rendered as real SVG vectors:

```jsx
// Real Lucide icons in JSX
<Frame name="Nav" flex="row" items="center" gap={8} bg="var:card" p={12} rounded={8}>
  <Icon name="lucide:home" size={20} color="var:foreground" />
  <Text size={14} weight="medium" color="var:foreground">Home</Text>
  <Frame grow={1} />
  <Icon name="lucide:settings" size={20} color="var:muted-foreground" />
</Frame>
```

Icons support:
- Any icon from [Lucide](https://lucide.dev/icons) (2000+ icons)
- Any icon set on [Iconify](https://iconify.design/) (150,000+ icons): `mdi:home`, `heroicons:star`, etc.
- Variable color binding with `var:` syntax
- Custom sizes

---

## Two Connection Modes

### 🚀 Yolo Mode (Recommended)

**What it does:** Patches Figma once to enable a debug port, then connects directly.

**Pros:**
- Fully automatic (no manual steps after setup)
- Slightly faster execution
- Secure: random port, token auth, localhost only, auto-shutdown on idle

**Cons:**
- Requires one-time Figma patch
- Needs Full Disk Access on macOS (one-time)

```
┌─────────────┐      WebSocket (CDP)      ┌─────────────┐
│     CLI     │ <------------------------> │   Figma     │
└─────────────┘    localhost:random port  └─────────────┘
```

```bash
node src/index.js connect
```

---

### 🔒 Safe Mode -- For Restricted Environments

**What it does:** Uses a Figma plugin to communicate. No Figma modification needed.

**Pros:**
- No patching, no app modification
- Works everywhere (corporate, personal, any environment)
- No Full Disk Access needed
- **Full feature parity** with Yolo Mode (all commands work)

**Cons:**
- Start plugin manually each session (2 clicks)
- Slightly slower than Yolo Mode

```
┌─────────────┐     WebSocket     ┌─────────────┐     Plugin API     ┌─────────────┐
│     CLI     │ <---------------> │   Daemon    │ <----------------> │   Plugin    │
└─────────────┘   localhost:3456  └─────────────┘                    └─────────────┘
```

**Step 1:** Start Safe Mode
```bash
fig-start --safe
```
Or manually: `node src/index.js connect --safe`

**Step 2:** Import plugin (one-time only)
1. In Figma: **Plugins -> Development -> Import plugin from manifest**
2. Select `plugin/manifest.json` from this project
3. Click **Open**

**Step 3:** Start the plugin (each session)
1. In Figma: **Plugins -> Development -> FigCli**
2. Terminal shows: `Plugin connected!`

**Tip:** Right-click the plugin -> **Add to toolbar** for quick access.

---

### Which Mode Should I Use?

| Situation | Command |
|---|---|
| First time user | `fig-start` (Yolo Mode) |
| Personal Mac | `fig-start` (Yolo Mode) |
| Corporate laptop | `fig-start --safe` |
| Permission errors with Yolo | `fig-start --safe` |
| Can't modify apps | `fig-start --safe` |

Both modes have **full feature parity**. Safe Mode uses native Figma Plugin API implementations instead of figma-use, so all commands work identically.

---

## Troubleshooting

### Permission Error When Patching (macOS)

If you see `EPERM: operation not permitted, open '.../app.asar'`:

**1. Grant Full Disk Access to Terminal**

macOS blocks file access without this permission, even with sudo.

1. Open **System Settings** -> **Privacy & Security** -> **Full Disk Access**
2. Click the **+** button
3. Add **Terminal** (or iTerm, VS Code, Warp, etc.)
4. **Restart Terminal completely** (quit and reopen)

**2. Make sure Figma is completely closed**
```bash
# Check if Figma is still running
ps aux | grep -i figma

# Force quit if needed
killall Figma
```

**3. Run connect again**
```bash
node src/index.js connect
```

If still failing, try with sudo: `sudo node src/index.js connect`

**4. Manual patch (last resort)**

If nothing works, you can patch manually:

```bash
# Backup original
sudo cp /Applications/Figma.app/Contents/Resources/app.asar ~/app.asar.backup

# The patch changes one string in the file
# From: removeSwitch("remote-debugging-port")
# To:   removeSwitch("remote-debugXing-port")

# Use a hex editor or this command:
sudo sed -i '' 's/remote-debugging-port/remote-debugXing-port/g' /Applications/Figma.app/Contents/Resources/app.asar

# Re-sign the app
sudo codesign --force --deep --sign - /Applications/Figma.app
```

### Windows

Windows is supported but less tested than macOS.

**Permission Error:** Run Command Prompt or PowerShell as Administrator, then run `node src/index.js connect`.

**Figma Location:** The CLI expects Figma at `%LOCALAPPDATA%\Figma\Figma.exe` (default install location).

**Safe Mode:** If Yolo Mode doesn't work, use Safe Mode: `node src/index.js connect --safe`

### Figma Not Connecting

1. Make sure Figma Desktop is running (not the web version)
2. Open a design file in Figma (not just the home screen)
3. Restart connection: `node src/index.js connect`

---

## Updating

```bash
cd ~/path/to/figma-cli
git pull
npm install
```

## How It Works

Connects to Figma Desktop via Chrome DevTools Protocol (CDP). No API key needed because it uses your existing Figma session.

```
┌─────────────┐      WebSocket (CDP)      ┌─────────────┐
│ figma-ds-cli │ <------------------------> │   Figma     │
│    (CLI)    │   localhost:9222-9322     │  Desktop    │
└─────────────┘      (random port)        └─────────────┘
```

### Security

The CLI runs a local daemon for faster command execution. Security features:

- **Session token authentication**: Random 32-byte token required for all requests
- **No CORS headers**: Blocks cross-origin browser requests
- **Host header validation**: Only accepts localhost/127.0.0.1
- **Idle timeout**: Auto-shutdown after 10 minutes of inactivity (configurable)
- **Random port**: CDP uses a random port between 9222-9322 per session

Token is stored at `~/.figma-ds-cli/.daemon-token` with owner-only permissions (0600).

---

## Full Feature List

### shadcn/ui Components

- **30 components, 58 variants** matching official shadcn/ui specs
- Real **Lucide SVG icons** (chevrons, check, x, plus, info, alert-circle, bold, ellipsis)
- **Design token binding** via `var:` syntax (auto-binds to shadcn Light/Dark mode variables)
- Components: Button (9), Badge (4), Card, Input (3), Textarea, Label, Alert (2), Avatar (2), Switch (2), Separator (2), Skeleton (3), Progress (2), Toggle (2), Checkbox (2), Tabs, Table, Radio Group (3), Select (3), Slider, Breadcrumb, Pagination, Kbd (2), Spinner (2), Tooltip, Dialog, Dropdown Menu, Accordion, Navigation Menu, Sheet, Hover Card

### Design Tokens & Variables

- **Color presets** -- shadcn (276 vars with Light/Dark mode), Radix UI (156 vars)
- Create Tailwind CSS color palettes (all 22 color families, 50-950 shades)
- Create and manage variable collections
- **Variable modes** (Light/Dark/Mobile) with per-mode values
- **Batch create** up to 100 variables at once
- **Batch update** variable values across modes
- Bind variables to node properties (fill, stroke, gap, padding, radius)
- Export variables as CSS custom properties
- Export variables as Tailwind config

### Create Elements

- Frames with auto-layout
- Rectangles, circles, ellipses
- Text with custom fonts, sizes, weights
- Lines
- Icons (150,000+ from Iconify: Lucide, Material Design, Heroicons, etc.)
- Groups
- Components from frames
- Component instances
- **Component sets with variants**

### JSX Rendering

- **JSX-like syntax** for complex layouts (`<Frame>`, `<Text>`, `<Icon>`, `<Slot>`)
- **Real Lucide/Iconify icons** rendered as SVG vectors (not placeholders)
- **Variable binding** with `var:name` syntax for fills, strokes, text colors, icon colors
- Auto-layout props: `flex`, `gap`, `p`/`px`/`py`, `justify`, `items`, `grow`, `wrap`
- Sizing: `w`/`h` (fixed), `w="fill"` (stretch), auto-hug
- Appearance: `bg`, `stroke`, `strokeWidth`, `strokeAlign`, `rounded`, `shadow`, `opacity`, `overflow`
- **Slots** for component content areas

### Modify Elements

- Change fill and stroke colors
- Set corner radius
- Resize and move
- Apply auto-layout (row/column, gap, padding)
- Set sizing mode (hug/fill/fixed)
- Rename nodes
- Duplicate nodes
- Delete nodes
- **Flip nodes** (horizontal/vertical)
- **Scale vectors**

### Find & Select

- Find nodes by name
- Find nodes by type (FRAME, COMPONENT, TEXT, etc.)
- **XPath-like queries** (`//FRAME[@width > 300]`)
- Select nodes by ID
- Get node properties
- Get node tree structure

### Canvas Operations

- List all nodes on canvas
- Arrange frames in grid or column
- Delete all nodes
- Zoom to fit content
- Smart positioning (auto-place without overlaps)

### Export

- **Export node by ID** (`export node "1:234" -s 2 -f png`)
- Export nodes as PNG (with scale factor)
- Export nodes as SVG
- **Export multiple sizes** (@1x, @2x, @3x)
- Take screenshots
- **Export to JSX** (React code)
- **Export to Storybook** stories
- Export variables as CSS
- Export variables as Tailwind config

### FigJam Support

- Create sticky notes
- Create shapes with text
- Connect elements with arrows
- List FigJam elements
- Run JavaScript in FigJam context

### Team Libraries

- List available library variable collections
- Import variables from libraries
- Import components from libraries
- Create instances of library components
- Import and apply library styles (color, text, effect)
- Bind library variables to node properties
- Swap component instances to different library components
- List all enabled libraries

### Designer Utilities

- **Batch rename layers** (with patterns: {n}, {name}, {type})
- **Case conversion** (camelCase, PascalCase, snake_case, kebab-case)
- **Lorem ipsum generator** (words, sentences, paragraphs)
- **Fill text with placeholder content**
- **Insert images from URL**
- **Unsplash integration** (random stock photos by keyword)
- **Contrast checker** (WCAG AA/AAA compliance)
- **Check text contrast** against background
- **Find and replace text** across all layers
- **Select same** (fill, stroke, font, size)
- **Color blindness simulation** (deuteranopia, protanopia, tritanopia)

### Query & Analysis

- **Analyze colors** -- usage frequency, variable bindings
- **Analyze typography** -- all font combinations used
- **Analyze spacing** -- gap/padding values, grid compliance
- **Find clusters** -- detect repeated patterns (potential components)
- **Visual diff** -- compare two nodes
- **Create diff patch** -- structural patches between versions

### Lint & Accessibility

- **Design linting** with 8+ rules:
  - `no-default-names` -- detect unnamed layers
  - `no-deeply-nested` -- flag excessive nesting
  - `no-empty-frames` -- find empty frames
  - `prefer-auto-layout` -- suggest auto-layout
  - `no-hardcoded-colors` -- check variable usage
  - `color-contrast` -- WCAG AA/AAA compliance
  - `touch-target-size` -- minimum 44x44 check
  - `min-text-size` -- minimum 12px text
- **Accessibility snapshot** -- extract interactive elements tree

### Component Variants

- Create component sets with variants
- Add variant properties
- Combine frames into component sets
- **Organize variants** into grid with labels
- **Auto-generate component sets** from similar frames

### Component Documentation

- **Add descriptions** to components (supports markdown)
- **Document with template** (usage, props, notes)
- Read component descriptions

### CSS Grid Layout

- Set up grid layout with columns and rows
- Configure column/row gaps
- Auto-reorganize children into grid

### Console & Debugging

- **List open Figma files** (`files` command, used by fig-start)
- **Capture console logs** from Figma
- **Execute code with log capture**
- **Reload page**
- **Navigate to files**

### Advanced

- Execute any Figma Plugin API code directly
- Render complex UI from JSX-like syntax
- Full programmatic control over Figma
- Match vectors to Iconify icons

### Not Supported (requires REST API)

- Comments (read/write/delete) -- requires Figma API key
- Version history
- Team/project management

---

## Author

**[Sil Bormueller](https://www.linkedin.com/in/silbormueller/)** -- [intodesignsystems.com](https://intodesignsystems.com)

## Powered By

This CLI is built on top of **[figma-use](https://github.com/dannote/figma-use)** by [dannote](https://github.com/dannote) -- an excellent Figma CLI with JSX rendering, XPath queries, design linting, and much more.

In **Yolo Mode**, we use figma-use for:
- JSX rendering (`render` command)
- Node operations (`node tree`, `node to-component`, etc.)
- Design analysis (`analyze colors`, `analyze typography`)
- Design linting (`lint`)
- And many other features

In **Safe Mode**, all commands use native Figma Plugin API implementations, so figma-use is not required.

**Big thanks to dannote for figma-use!**

## License

MIT
