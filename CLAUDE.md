# figma-ds-cli

CLI that controls Figma Desktop directly. No API key needed.

## Quick Reference

| User says | Command |
|-----------|---------|
| "connect to figma" | `figma-cli connect` |
| "add shadcn colors" | `figma-cli tokens preset shadcn` |
| "add tailwind colors" | `figma-cli tokens tailwind` |
| "show colors on canvas" | `figma-cli var visualize` |
| "create dashboard" | `figma-cli blocks create dashboard-01` |
| "list blocks" | `figma-cli blocks list` |
| "create cards/buttons" | `render-batch` + `node to-component` |
| "create a rectangle/frame" | `figma-cli render '<Frame>...'` |
| "convert to component" | `figma-cli node to-component "ID"` |
| "list variables" | `figma-cli var list` |
| "find nodes named X" | `figma-cli find "X"` |
| "what's on canvas" | `figma-cli canvas info` |
| "export as PNG/SVG" | `figma-cli export png` |
| "extract gradient from image" / "rebuild this gradient" | `figma-cli gradient extract <image>` |
| "apply image gradient to a frame" | `figma-cli gradient extract <image> --apply-to <nodeId>` |
| "match this mesh / blossom / aurora background" | `figma-cli gradient extract <image> --mode mesh --apply-to <frameId>` |
| "create a wallpaper / mesh gradient from these colors" | `figma-cli gradient mesh "#a,#b,#c" --size 1920x1080` |

**Wallpaper palette tip:** for rich results pass **5-6 hue-diverse colors** (mix warm + cool + a bright accent), not shades of one color. Analogous palettes blend into a flat 2-tone wash. The command auto-adds a depth anchor + focal glow, and `--style auto` rotates compositions (scatter/diagonal/bands/drift/spotlight/corners). For N wallpapers, run it N times with different palettes + styles.
| "show all variants" | `figma-cli combos` |
| "create size variants" | `figma-cli sizes --base small` |
| "make these frames a variant set" / "combine into variants" | `figma-cli variants from <ids> --property Size --values Small,Medium,Large --name Button` |
| "combine existing components into a variant set" | `figma-cli prop combine <ids> --name Button` |
| "create a slot" | `figma-cli slot create "Name"` |
| "list slots" | `figma-cli slot list` |
| "reset slot" | `figma-cli slot reset` |
| "verify creation" | `figma-cli verify` |
| "check contrast" | `figma-cli a11y contrast` |
| "color blindness sim" | `figma-cli a11y vision` |
| "check touch targets" | `figma-cli a11y touch` |
| "check text a11y" | `figma-cli a11y text` |
| "full a11y audit" | `figma-cli a11y audit` |
| "show plugins" | `figma-cli plugins` |
| "install voice" | `figma-cli plugins install voice` |
| "setup voice key" | `figma-cli plugins setup voice` (in regular Terminal!) |
| "voice mode" | `figma-cli voice` |
| "chat with figma" | `figma-cli chat "build a button"` |

**Full command reference:** See REFERENCE.md

---

## Key Rules

1. **Always use `render` for frames** - has smart positioning
2. **Never use `eval` to create new visual nodes** - no positioning, overlaps at (0,0), and bypasses every safety guard (auto-split, name dedup, constraints, fills). `eval` is for Plugin API operations that have no equivalent CLI subcommand. Period.
3. **Never use `npx figma-use render`** - no smart positioning
4. **For multiple frames:** Use `render-batch`
5. **Convert to components:** `node to-component` after creation
6. **Never show terminal commands to users.** Run silently, give friendly feedback.
7. **NEVER delete existing nodes** - users may have components they want to keep!
8. **Always verify after creating:** `figma-cli verify "NODE_ID"`

### 🎨 THEMED vs SHADCN (read the user's intent)

When the user asks for components, two distinct universes exist:

| User says | Means | Use |
|---|---|---|
| "create 3 buttons" / "add a card" | shadcn-style primitives are fine | `figma-cli shadcn add button --count 3` |
| "create 4 buttons **using variables / in figma style / themed / using the loaded design system / with tokens**" | wants CUSTOM-rendered components bound to the user's currently-loaded design system variables | `figma-cli render-batch '[…var:primary, var:on-primary…]'` |

`shadcn add` ignores any loaded DESIGN.md / variable collection. It produces shadcn's own primitives in shadcn's own colors. If the user has imported Airbnb / Cursor / their in-house system and asks for "4 buttons with the variables", they expect those VARIABLE-BOUND buttons — not shadcn ones. **Read the user's wording before defaulting to `shadcn add`.**

**`--count` semantics for `shadcn add`:**
- `figma-cli shadcn add button` → renders all 9 button variants once (variant gallery)
- `figma-cli shadcn add button --count 4` → 4 copies of the DEFAULT variant (4 buttons total, not 4×9=36)
- `figma-cli shadcn add card --count 3` → 3 cards (Card has 1 variant, so 3 buttons)

**Don't use `rounded="var:md"` in JSX.** `rounded=` takes a number. Look up the radius token's px value via `figma-cli var list` (e.g. `rounded={8}`).

### 🎯 PINNING TO A SPECIFIC COLLECTION (when the user names one)

When the user has multiple variable collections (e.g. `figma`, `cursor`, `airbnb`, `miro`) and asks for variables from **a named one**, you MUST pass `--collection <name>` to `render` / `render-batch`. Otherwise the resolver picks an arbitrary collection (shadcn-priority by default) and `var:primary` ends up resolving against the wrong system.

**Detect the pattern from user wording:**

| User says | Add to the command |
|---|---|
| "use **figma** variables" / "**figma** style" / "**figma** collection" | `--collection figma` |
| "use **airbnb** variables" / "in **airbnb** style" | `--collection airbnb` |
| "**cursor** themed" / "use **cursor** tokens" | `--collection cursor` |
| Generic "use variables" / "themed" (no system named) | use the most-recently-imported collection if known; otherwise ask which one |

**Example — the right command for "create 4 buttons use figma variables collection":**

```bash
figma-cli render-batch '[
  "<Frame name=\"Button Primary\" bg=\"var:primary\" px={20} py={12} rounded={8} flex=\"row\" justify=\"center\" items=\"center\"><Text color=\"var:on-primary\" size={14} weight=\"medium\">Primary</Text></Frame>",
  "<Frame name=\"Button Secondary\" bg=\"var:surface-card\" stroke=\"var:hairline\" strokeWidth={1} px={20} py={12} rounded={8} flex=\"row\" justify=\"center\" items=\"center\"><Text color=\"var:ink\" size={14} weight=\"medium\">Secondary</Text></Frame>",
  "<Frame name=\"Button Outline\" stroke=\"var:hairline-strong\" strokeWidth={1} px={20} py={12} rounded={8} flex=\"row\" justify=\"center\" items=\"center\"><Text color=\"var:ink\" size={14} weight=\"medium\">Outline</Text></Frame>",
  "<Frame name=\"Button Ghost\" px={20} py={12} rounded={8} flex=\"row\" justify=\"center\" items=\"center\"><Text color=\"var:body\" size={14} weight=\"medium\">Ghost</Text></Frame>"
]' --direction row --collection figma
```

That one line is correct, atomic, and produces 4 independent buttons whose `var:` references all resolve against the `figma` collection — not Cursor, not Airbnb. **One call, no fallback to individual `render` invocations needed.**

**Per-attribute override:** `bg="var:cursor:primary"` even forces a specific collection for one binding (useful when mixing systems intentionally).

### 🛑 MULTI-ITEM CREATION (the rule that gets violated the most)

**The intent test:** "user asked for N <noun>" → **N independent top-level nodes on the canvas**. NOT one wrapper Component containing N children. NOT one Frame with `flex="row"`. N separate nodes.

| User says | RIGHT | WRONG |
|---|---|---|
| "create 3 buttons" | `figma-cli shadcn add button --count 3` | a Component called "buttons" containing 3 buttons |
| "create 5 cards" | `figma-cli shadcn add card --count 5` | a Frame called "Cards" with 5 children |
| "5 custom pricing cards" | `figma-cli render-batch '["<Frame>...</Frame>", …]' --direction row` | `figma-cli eval` writing a script that creates a parent + appendChild × 5 |
| "make a card with title + button" | ONE Frame containing title + button (legit composition) | (this case is fine — different children, single component is correct) |

**Why this matters:** users want to move, reuse, or convert each item individually. Bundling them into a Component breaks every downstream operation (`figma-cli use <theme>`, drag-to-move, individual `to-component`).

**Forbidden patterns:**
- `figma-cli eval --file <script>` where the script does `figma.createFrame()` + `figma.createComponent()` + `parent.appendChild()` more than once to wrap "N items"
- `figma-cli render '<Frame><Frame>btn1</Frame><Frame>btn2</Frame>...</Frame>'` (auto-split catches this, but don't rely on it)
- `figma-cli node to-component` on a wrapper Frame that contains N similar children

**If you accidentally did it:** `figma-cli unwrap <wrapperId>` rescues the children to the parent and deletes the wrapper. Use it.

**eval is allowed for:**
- Single-node operations that don't have a CLI command (e.g. setting an obscure Plugin API property)
- Bulk reads (querying current state)
- Operations that mutate existing nodes (not creation)

---

## AI Verification

After creating any component, run `verify` to get a small screenshot for validation:

```bash
figma-cli verify              # Screenshot of selection
figma-cli verify "123:456"    # Screenshot of specific node
```

Returns JSON with base64 image (max 2000px). This is for internal AI checks, not shown to users.

---

## Blocks (Pre-built UI Layouts)

**ALWAYS use `blocks create` for dashboards and page layouts.** Never build them manually.

```bash
figma-cli blocks list                    # Show available blocks
figma-cli blocks create dashboard-01     # Create dashboard in Figma
```

**dashboard-01**: Full analytics dashboard (sidebar, stats cards, area chart, data table). All colors bound to shadcn variables (Light/Dark mode). Block source files: `src/blocks/`

---

## Design Tokens

```bash
figma-cli tokens preset shadcn   # 244 primitives + 32 semantic (Light/Dark)
figma-cli tokens tailwind        # 242 primitive colors only
figma-cli tokens ds              # IDS Base colors
figma-cli var delete-all         # Delete all variables
figma-cli var delete-all -c "primitives"  # Only specific collection
```

- `tokens preset shadcn` = Full system (primitives + semantic with Light/Dark mode)
- `tokens tailwind` = Just the Tailwind color palette (primitives only)
- `var list` only SHOWS variables. Use `tokens` commands to CREATE them.

---

## Variable Binding (var: syntax)

Use `var:name` to bind variables at creation time. Works with `render`, `create`, and `set` commands:

```bash
# JSX render
figma-cli render '<Frame bg="var:card" stroke="var:border" rounded={12} p={24}>
  <Text color="var:foreground" size={18}>Title</Text>
</Frame>'

# Create commands
figma-cli create rect "Card" --fill "var:card" --stroke "var:border"

# Set commands
figma-cli set fill "var:primary"
```

**Available shadcn variables:** `background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `accent`, `border`, `input`, `ring`, and their `-foreground` variants.

---

## Connection Modes

**Yolo Mode (Recommended):** `figma-cli connect` - Patches Figma once, fully automatic.

**Safe Mode:** `figma-cli connect --safe` - Plugin-based, no Figma modification. Then: Plugins > Development > FigCli.

**Safe Mode:** `render` and `render-batch` work the same as in Yolo Mode, including text. Use `eval` with the native Figma API only when JSX can't express what you need.

---

## JSX Syntax (render command)

```jsx
// Layout
flex="row"              // or "col"
gap={16}                // spacing
p={24}                  // padding all sides
px={16} py={8}          // padding x/y
pt={8} pr={16} pb={8} pl={16}

// Alignment
justify="center"        // main axis: start, center, end, between
items="center"          // cross axis: start, center, end

// Size
w={320} h={200}         // fixed
w="fill" h="fill"       // fill parent
minW={100} maxW={500} minH={50} maxH={300}

// Appearance
bg="#fff"               // fill color
bg="var:card"           // bind to variable
stroke="#000"           // stroke
strokeWidth={2}         strokeAlign="inside"
opacity={0.8}           blendMode="multiply"

// Corners & Effects
rounded={16}            // all corners
roundedTL={8} roundedTR={8} roundedBL={0} roundedBR={0}
cornerSmoothing={0.6}   // iOS squircle
shadow="4px 4px 12px rgba(0,0,0,0.25)"
blur={8}                overflow="hidden"       rotate={45}

// Auto-Layout
wrap={true}             // flow to next row (HORIZONTAL only)
rowGap={12}             // gap between rows
grow={1}                // fill remaining space
stretch={true}          // fill cross-axis
position="absolute" x={12} y={12}  // must have name for x/y

// Text
<Text size={18} weight="bold" color="#000" font="Inter">Hello</Text>

// Icons (real SVG via Iconify API)
<Icon name="lucide:home" size={20} color="#fff" />
<Icon name="lucide:check" size={14} color="var:primary-foreground" />

// Slots (inside components)
<Slot name="Content" flex="col" gap={8} w="fill" />
```

**Common mistakes (silently ignored, no error!):**
```
WRONG                    RIGHT
layout="horizontal"   →  flex="row"
padding={24}          →  p={24}
fill="#fff"           →  bg="#fff"
cornerRadius={12}     →  rounded={12}
fontSize={18}         →  size={18}
fontWeight="bold"     →  weight="bold"
```

---

## Critical Pitfalls

### 1. Text gets cut off (MOST COMMON BUG)

**Rule:** For text to wrap, BOTH parent AND every Text element need `w="fill"`:

```jsx
// BAD: Text clips to single line
<Frame flex="col" gap={8}>
  <Text size={16} weight="semibold" color="#fff">Long title gets cut off</Text>
  <Text size={14} color="#a1a1aa">Description also cut off</Text>
</Frame>

// GOOD: w="fill" on parent AND ALL text elements
<Frame flex="col" gap={8} w="fill">
  <Text size={16} weight="semibold" color="#fff" w="fill">Long title wraps correctly</Text>
  <Text size={14} color="#a1a1aa" w="fill">Description wraps correctly</Text>
</Frame>
```

This applies to ALL text: titles, descriptions, labels, any multi-word text.

### 2. Toggle switches: use flex, not absolute positioning

```jsx
// ON (knob right)
<Frame w={52} h={28} bg="#3b82f6" rounded={14} flex="row" items="center" p={2} justify="end">
  <Frame w={24} h={24} bg="#fff" rounded={12} />
</Frame>
// OFF (knob left)
<Frame w={52} h={28} bg="#27272a" rounded={14} flex="row" items="center" p={2} justify="start">
  <Frame w={24} h={24} bg="#52525b" rounded={12} />
</Frame>
```

### 3. Buttons need flex for centered text

```jsx
<Frame bg="#3b82f6" px={16} py={10} rounded={10} flex="row" justify="center" items="center">
  <Text color="#fff">Button</Text>
</Frame>
```

### 4. No emojis: use Lucide icons or shapes

```jsx
// BAD: Emojis render inconsistently
<Text>🏠</Text>

// GOOD: Real Lucide icons
<Icon name="lucide:home" size={20} color="#fff" />

// OK: Shape placeholders
<Frame w={20} h={20} rounded={4} stroke="#fff" strokeWidth={2} />
```

### 5. Three-dot menu / Star rating with shapes

```jsx
// Three dots
<Frame flex="row" gap={3} justify="center" items="center">
  <Frame w={4} h={4} bg="#52525b" rounded={2} />
  <Frame w={4} h={4} bg="#52525b" rounded={2} />
  <Frame w={4} h={4} bg="#52525b" rounded={2} />
</Frame>

// Star rating
<Frame flex="row" gap={4}>
  <Frame w={14} h={14} bg="#fbbf24" rounded={2} />
  <Frame w={14} h={14} bg="#fbbf24" rounded={2} />
  <Frame w={14} h={14} bg="#fbbf24" rounded={2} />
</Frame>
```

### 6. Push items to edges (navbar): use grow spacer

```jsx
// justify="between" doesn't work reliably
<Frame flex="row" items="center">
  <Frame>Logo</Frame>
  <Frame grow={1} />
  <Frame>Buttons</Frame>
</Frame>
```

### 7. Slots: isSlot does NOT work in eval

Setting `frame.isSlot = true` in eval will NOT create a slot. Use:
```bash
figma-cli slot convert "frame-id" --name "SlotName"
```

---

## Slots (Quick Reference)

```bash
figma-cli slot create "Content" --flex col --gap 8 --padding 16
figma-cli slot list
figma-cli slot preferred "Slot#1:2" "comp-id-1" "comp-id-2"
figma-cli slot reset
figma-cli slot convert --name "Actions"    # Convert frame to slot
figma-cli slot add "slot-id" --component "comp-id"
```

JSX: `<Slot name="Content" flex="col" gap={8} w="fill" />` (creates real slot when parent is component)

---

## Variant Sets (Frames or Components → Component Set)

When a user has N frames (or N components) that should become one component with variants, use `variants from`. It auto-promotes any FRAMEs to COMPONENTs, renames them `Property=Value` so Figma derives exactly one variant property, then calls `figma.combineAsVariants`. The result is a real Component Set you can swap variants on in the right panel.

```bash
# Frames → variant set in one call
figma-cli variants from 1:2,1:3,1:4 \
  --property Size --values Small,Medium,Large --name Button

# Works for any property axis: state, color, density, intent
figma-cli variants from 5:10,5:11 --property State --values Default,Hover
```

**When NOT to use it:**
- One frame that should just become a single component → use `node to-component`.
- Components that are already inside a Component Set → already done.
- You want to swap variant axes / rename an existing property → use `prop` subcommands.

**Naming gotcha:** the variant *property* name lives only on the property (`Size`, `State`, …). Don't prefix the values with the component name — `--values Button-Small,Button-Medium` would create variants literally named that.

---

## Onboarding

1. Run `npm install` silently
2. Ask connection mode (Yolo or Safe)
3. Run `figma-cli connect` (or `--safe`)
4. When connected, say: "Connected! What would you like to create?"

If permission error (macOS): System Settings > Privacy > Full Disk Access > Add Terminal

---

## Other Commands

```bash
figma-cli var visualize              # Show colors on canvas
figma-cli var visualize "primitives" # Filter by collection
figma-cli recreate-url "URL"         # Recreate webpage in Figma
figma-cli screenshot-url "URL"       # Screenshot webpage
figma-cli daemon status              # Check daemon
figma-cli daemon restart             # Restart daemon
```

For eval patterns, layout examples, and Safe Mode templates, see REFERENCE.md.
