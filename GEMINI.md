# figma-ds-cli

CLI that controls Figma Desktop directly. No API key needed.

## Quick Reference

| User says | Command |
|-----------|---------|
| "connect to figma" | `node src/index.js connect` |
| "add shadcn colors" | `node src/index.js tokens preset shadcn` |
| "add tailwind colors" | `node src/index.js tokens tailwind` |
| "show colors on canvas" | `node src/index.js var visualize` |
| "create dashboard" | `node src/index.js blocks create dashboard-01` |
| "list blocks" | `node src/index.js blocks list` |
| "create cards/buttons" | `render-batch` + `node to-component` |
| "create a rectangle/frame" | `node src/index.js render '<Frame>...'` |
| "convert to component" | `node src/index.js node to-component "ID"` |
| "list variables" | `node src/index.js var list` |
| "find nodes named X" | `node src/index.js find "X"` |
| "what's on canvas" | `node src/index.js canvas info` |
| "export as PNG/SVG" | `node src/index.js export png` |
| "show all variants" | `node src/index.js combos` |
| "create size variants" | `node src/index.js sizes --base small` |
| "create a slot" | `node src/index.js slot create "Name"` |
| "list slots" | `node src/index.js slot list` |
| "reset slot" | `node src/index.js slot reset` |
| "verify creation" | `node src/index.js verify` |

**Full command reference:** See REFERENCE.md

---

## AI Verification (Internal)

After creating any component, run `verify` to get a small screenshot for validation:

```bash
node src/index.js verify              # Screenshot of selection
node src/index.js verify "123:456"    # Screenshot of specific node
```

Returns JSON with base64 image (max 2000px, auto-scaled to stay under API limits).

**Always verify after:**
- `render` or `render-batch`
- `node to-component`
- Any visual creation

This is for internal AI checks, not shown to users.

---

## Blocks (Pre-built UI Layouts)

**ALWAYS use `blocks create` for dashboards and page layouts.** Never build them manually with render/eval.

```bash
node src/index.js blocks list                    # Show available blocks
node src/index.js blocks create dashboard-01     # Create dashboard in Figma
```

**dashboard-01**: Full analytics dashboard with:
- Sidebar with real Lucide icons (layout-dashboard, refresh-cw, bar-chart-3, folder, users, etc.)
- Stats cards (Revenue, Customers, Accounts, Growth)
- Area chart with two datasets
- Data table with pagination
- All colors bound to shadcn variables (supports Light/Dark mode)

**Dark mode copy**: After creating, clone and switch mode:
```javascript
// Via eval:
var clone = dashboard.clone();
clone.name = 'Dashboard (Dark)';
clone.setExplicitVariableModeForCollection(semanticCollection, darkModeId);
```

Block source files: `src/blocks/`

---

## Design Tokens

"Add shadcn colors":
```bash
node src/index.js tokens preset shadcn   # 244 primitives + 32 semantic (Light/Dark)
```

"Add tailwind colors":
```bash
node src/index.js tokens tailwind        # 242 primitive colors only
```

"Create design system":
```bash
node src/index.js tokens ds              # IDS Base colors
```

**shadcn vs tailwind:**
- `tokens preset shadcn` = Full shadcn system (primitives + semantic tokens with Light/Dark mode)
- `tokens tailwind` = Just the Tailwind color palette (primitives only)

"Delete all variables":
```bash
node src/index.js var delete-all                    # All collections
node src/index.js var delete-all -c "primitives"    # Only specific collection
```

**Note:** `var list` only SHOWS existing variables. Use `tokens` commands to CREATE them.

---

## Fast Variable Binding (var: syntax)

Use `var:name` syntax to bind variables directly at creation time (currently searches shadcn collections):

### Create Commands with var:
```bash
node src/index.js create rect "Card" --fill "var:card" --stroke "var:border"
node src/index.js create circle "Avatar" --fill "var:primary"
node src/index.js create text "Hello" -c "var:foreground"
node src/index.js create line -c "var:border"
node src/index.js create frame "Section" --fill "var:background"
node src/index.js create autolayout "Container" --fill "var:muted"
node src/index.js create icon lucide:star -c "var:primary"
```

### JSX render with var:
```bash
node src/index.js render '<Frame bg="var:card" stroke="var:border" rounded={12} p={24}>
  <Text color="var:foreground" size={18}>Title</Text>
</Frame>'
```

### Set commands with var:
```bash
node src/index.js set fill "var:primary"
node src/index.js set stroke "var:border"
```

**Variables:** `background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `accent`, `border`, and their `-foreground` variants.

---

## Connection Modes

### Yolo Mode (Recommended)
Patches Figma once, then connects directly. Fully automatic.
```bash
node src/index.js connect
```

### Safe Mode
Uses plugin, no Figma modification. Start plugin each session.
```bash
node src/index.js connect --safe
```
Then: Plugins → Development → FigCli

**Safe Mode Notes:**
- All commands work via daemon (no figma-use dependency)
- 60s timeout (same as Yolo Mode)
- **CRITICAL: `render-batch` does NOT render text properly in Safe Mode!**
- Use `eval` with direct Figma API for components with text

---

## Creating Components (Safe Mode)

**DO NOT use render-batch for components with text in Safe Mode.** Use `eval` with native Figma API:

```javascript
node src/index.js eval "(async () => {
  // 1. Load fonts FIRST
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

  // 2. Create frame with FIXED width
  const card = figma.createFrame();
  card.name = 'Card';
  card.x = 100; card.y = 100;
  card.resize(340, 1); // Fixed width!
  card.layoutMode = 'HORIZONTAL';
  card.primaryAxisSizingMode = 'FIXED'; // Keep width fixed
  card.counterAxisSizingMode = 'AUTO';  // Height hugs content
  card.paddingTop = card.paddingBottom = card.paddingLeft = card.paddingRight = 20;
  card.itemSpacing = 16;
  card.cornerRadius = 12;
  card.fills = [{ type: 'SOLID', color: { r: 0.094, g: 0.094, b: 0.106 } }];

  // 3. Content frame must FILL remaining space
  const content = figma.createFrame();
  content.fills = [];
  content.layoutMode = 'VERTICAL';
  content.itemSpacing = 4;
  card.appendChild(content);
  content.layoutSizingHorizontal = 'FILL'; // Critical!

  // 4. Text must FILL to wrap
  const title = figma.createText();
  title.fontName = { family: 'Inter', style: 'Bold' };
  title.characters = 'Title here';
  title.fontSize = 14;
  title.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  content.appendChild(title);
  title.layoutSizingHorizontal = 'FILL'; // Critical!

  // 5. Convert to component
  const comp = figma.createComponentFromNode(card);
  return { id: comp.id, name: comp.name };
})()"
```

**Auto-Layout Rules (Text Cut-Off Prevention):**
1. Parent frame needs `resize(WIDTH, 1)` + `primaryAxisSizingMode = 'FIXED'`
2. Child content frames need `layoutSizingHorizontal = 'FILL'` AFTER appendChild
3. ALL text nodes need `layoutSizingHorizontal = 'FILL'` AFTER appendChild
4. Order matters: appendChild first, then set layoutSizingHorizontal

**Before Creating - Check Positions:**
```javascript
// Check what's on page to avoid overlap
const nodes = figma.currentPage.children.map(n => ({
  name: n.name,
  x: n.x,
  width: n.width
}));
// Find rightmost edge, place new components after it
const maxX = Math.max(0, ...nodes.map(n => n.x + n.width)) + 100;
```

**NEVER delete existing nodes** - users may have components they want to keep!

**After Creating - Always Verify:**
```bash
node src/index.js verify "NODE_ID"  # Take screenshot and check visually
```

---

## Complex Components (Pricing Cards, etc.)

For complex multi-element components, use a **single eval** with native Figma API instead of JSX:

### Pattern
1. **Check for variables first** - don't assume any collection exists
2. **Use fallback colors** when no variables present
3. **Single eval** - create everything in one API call
4. **Data-driven** - define content in array, loop to create
5. **Equal height** - use `layoutAlign: "STRETCH"` and `layoutGrow: 1`

### Fallback Colors (Dark Theme)
```javascript
const colors = {
  bg: { r: 0.09, g: 0.09, b: 0.11 },       // #17171c
  card: { r: 0.11, g: 0.11, b: 0.13 },     // #1c1c21
  border: { r: 0.2, g: 0.2, b: 0.22 },     // #333338
  primary: { r: 0.23, g: 0.51, b: 0.97 },  // #3b82f8
  text: { r: 0.98, g: 0.98, b: 0.98 },     // #fafafa
  muted: { r: 0.6, g: 0.6, b: 0.65 },      // #999aa6
  white: { r: 1, g: 1, b: 1 }
};
```

### Variable Detection
```javascript
// Check for ANY variables, not just shadcn
const collections = await figma.variables.getLocalVariableCollectionsAsync();
if (collections.length > 0) {
  // Ask user which collection to use
} else {
  // Use fallback colors
}
```

### Equal Height Cards
```javascript
// After creating cards in container:
for (const card of container.children) {
  card.layoutAlign = 'STRETCH';           // Fill container height
  card.primaryAxisSizingMode = 'FIXED';   // Keep fixed width
  for (const child of card.children) {
    if (child.name === 'Features') {
      child.layoutGrow = 1;               // Features section grows
    }
  }
}
```

---

## Creating Webpages

Create ONE parent frame with vertical auto-layout containing all sections:

```bash
node src/index.js render '<Frame name="Landing Page" w={1440} flex="col" bg="#0a0a0f">
  <Frame name="Hero" w="fill" h={800} flex="col" justify="center" items="center" gap={24} p={80}>
    <Text size={64} weight="bold" color="#fff">Headline</Text>
    <Frame bg="#3b82f6" px={32} py={16} rounded={8}><Text color="#fff">CTA</Text></Frame>
  </Frame>
  <Frame name="Features" w="fill" flex="row" gap={40} p={80} bg="#111">
    <Frame flex="col" gap={12} grow={1}><Text size={24} weight="bold" color="#fff">Feature 1</Text></Frame>
  </Frame>
</Frame>'
```

---

## Slots

Figma's native slots feature allows flexible content areas in components. Slots let designers add, remove, and reorder content in instances without detaching.

### Slot Commands

```bash
# Create slot on selected component
node src/index.js slot create "Content" --flex col --gap 8 --padding 16

# List slots in component
node src/index.js slot list
node src/index.js slot list "component-id"

# Set preferred components for a slot
node src/index.js slot preferred "Slot#1:2" "component-id-1" "component-id-2"

# Reset slot in instance to defaults
node src/index.js slot reset
node src/index.js slot reset "slot-node-id"

# Convert frame to slot (must be inside component)
node src/index.js slot convert --name "Actions"

# Add content to slot in instance
node src/index.js slot add "slot-id" --component "component-id"
node src/index.js slot add "slot-id" --frame
node src/index.js slot add "slot-id" --text "Hello"
```

### JSX Slot Syntax

Use `<Slot>` in JSX to create slots. When parent is a component, creates real SLOT. Otherwise falls back to frame.

```jsx
<Frame name="Card" w={300} h={200} bg="#18181b" rounded={12} flex="col" p={16} gap={12}>
  <Text size={18} weight="bold" color="#fff">Card Title</Text>
  <Slot name="Content" flex="col" gap={8} w="fill">
    <Text size={14} color="#a1a1aa">Default slot content</Text>
  </Slot>
</Frame>
```

**Slot props:**
- `name` - Slot name (shown in properties panel)
- `flex` - Layout direction: "row" or "col"
- `gap` - Spacing between items
- `p`, `px`, `py` - Padding
- `w`, `h` - Size ("fill" or fixed)
- `bg` - Background fill

**Self-closing slot (empty):**
```jsx
<Slot name="Actions" flex="row" gap={8} />
```

### Slot Workflow

1. **Create component with slot:**
```bash
# Render component structure
node src/index.js render '<Frame name="Card" ...>
  <Slot name="Content" flex="col" w="fill" />
</Frame>'

# Convert to component
node src/index.js node to-component "frame-id"
```

2. **Or add slot to existing component:**
```bash
# Select component, then:
node src/index.js slot create "Content" --flex col --gap 8
```

3. **Set preferred components:**
```bash
node src/index.js slot preferred "Slot#1:2" "button-comp-id" "icon-comp-id"
```

**CRITICAL: `isSlot = true` does NOT work in eval!**
Setting `frame.isSlot = true` directly in Figma API code will NOT create a slot. You MUST use:
```bash
node src/index.js slot convert "frame-id" --name "SlotName"
```

4. **In instances, slots allow:**
- Adding any content (or only preferred if set)
- Reordering children
- Removing children
- Reset to defaults with `slot reset`

---

## JSX Syntax (render command)

```jsx
// Layout
flex="row"              // or "col"
gap={16}                // spacing between items
p={24}                  // padding all sides
px={16} py={8}          // padding x/y
pt={8} pr={16} pb={8} pl={16}  // individual padding

// Alignment
justify="center"        // main axis: start, center, end, between
items="center"          // cross axis: start, center, end

// Size
w={320} h={200}         // fixed size
w="fill" h="fill"       // fill parent
minW={100} maxW={500}   // constraints
minH={50} maxH={300}

// Appearance
bg="#fff"               // fill color
bg="var:card"           // bind to variable (FAST, inline binding)
stroke="#000"           // stroke color
stroke="var:border"     // bind stroke to variable
strokeWidth={2}         // stroke thickness
strokeAlign="inside"    // inside, outside, center
opacity={0.8}           // 0..1
blendMode="multiply"    // multiply, overlay, etc.

// Corners
rounded={16}            // all corners
roundedTL={8} roundedTR={8} roundedBL={0} roundedBR={0}  // individual
cornerSmoothing={0.6}   // iOS squircle (0..1)

// Effects
shadow="4px 4px 12px rgba(0,0,0,0.25)"  // drop shadow
blur={8}                // layer blur
overflow="hidden"       // clip content
rotate={45}             // rotation degrees

// Text
<Text size={18} weight="bold" color="#000" font="Inter">Hello</Text>
<Text color="var:foreground">Text with variable color</Text>

// Icons (Lucide via Iconify API - real SVG nodes, not placeholders)
<Icon name="lucide:chevron-left" size={16} color="#fff" />
<Icon name="lucide:check" size={14} color="var:primary-foreground" />
// Any Lucide icon: lucide:plus, lucide:x, lucide:search, lucide:settings, etc.
// Full list: https://lucide.dev/icons
```

### Fast Variable Binding (var: syntax)

Use `var:name` syntax to bind variables directly at creation time (FAST, no separate bind commands needed):

```jsx
// Frame with bound fill and stroke
<Frame bg="var:card" stroke="var:border">
  <Text color="var:foreground">Bound text</Text>
  <Frame bg="var:primary">
    <Text color="var:primary-foreground">Button</Text>
  </Frame>
</Frame>
```

**Available shadcn variables:**
- `background`, `foreground` (page background/text)
- `card`, `card-foreground` (card backgrounds)
- `primary`, `primary-foreground` (buttons, accents)
- `secondary`, `secondary-foreground`
- `muted`, `muted-foreground` (subtle text)
- `accent`, `accent-foreground`
- `border`, `input`, `ring`

**Advantages over separate `bind` commands:**
- Single render call binds all variables at once
- No timeouts or multiple API calls
- Works with complex nested structures

**Also works with `set` commands:**
```bash
node src/index.js set fill "var:primary"    # Bind fill to existing element
node src/index.js set stroke "var:border"   # Bind stroke to existing element
```

### Auto-Layout

```jsx
// Wrap: items flow to next row when full
wrap={true}             // layoutWrap = 'WRAP'
rowGap={12}             // gap between rows (counterAxisSpacing)

// Grow: expand to fill remaining space
grow={1}                // layoutGrow = 1

// Stretch: fill cross-axis
stretch={true}          // layoutAlign = 'STRETCH'

// Absolute: position freely within parent
position="absolute" x={12} y={12}  // must have name for x/y to work
```

**Complete example:**
```bash
node src/index.js render '<Frame name="Card" w={300} flex="col" bg="#18181b" rounded={12} overflow="hidden">
  <Frame w="fill" h={100} bg="#333" />
  <Frame name="Badge" w={40} h={20} bg="#ef4444" rounded={4} position="absolute" x={12} y={12} />
  <Frame name="Tags" flex="row" wrap={true} rowGap={8} gap={8} p={16}>
    <Frame w={60} h={24} bg="#3b82f6" rounded={12} />
    <Frame w={70} h={24} bg="#22c55e" rounded={12} />
    <Frame w={80} h={24} bg="#a855f7" rounded={12} />
  </Frame>
  <Frame flex="row" p={16} gap={8}>
    <Frame w={40} h="fill" bg="#222" />
    <Frame h="fill" bg="#333" grow={1} />
  </Frame>
</Frame>'
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
justify="between"     →  use grow={1} spacer instead
```

### Layout Patterns

**Push items to edges (navbar pattern):**
```jsx
// justify="between" doesn't work reliably, use grow spacer instead
<Frame flex="row" items="center">
  <Frame>Logo</Frame>
  <Frame grow={1} justify="center">Nav Links</Frame>
  <Frame>Buttons</Frame>
</Frame>
```

**Badge at avatar corner:**
```jsx
// Absolute x/y is relative to parent padding
// Avatar at padding=24, size=100, badge=20
// Position: padding + avatarSize - badgeSize/2 = 24 + 100 - 10 = 114
<Frame p={24}>
  <Frame w={100} h={100} rounded={50} />
  <Frame name="Badge" w={20} h={20} position="absolute" x={114} y={114} />
</Frame>
```

**Input at bottom (chat pattern):**
```jsx
<Frame flex="col" h={400}>
  <Frame>Message 1</Frame>
  <Frame>Message 2</Frame>
  <Frame grow={1} />
  <Frame>Input field</Frame>
</Frame>
```

**Avoid content overflow:**
```jsx
// BAD: fixed height too small for auto-sized children
<Frame h={160} p={24}><Frame h={139} /></Frame>  // 139+48 > 160!

// GOOD: ensure height fits content + padding
<Frame h={200} p={24}><Frame h={139} /></Frame>  // 139+48 < 200 ✓
```

**Complete card example:**
```bash
node src/index.js render '<Frame name="Card" w={320} h={200} bg="#18181b" rounded={12} flex="col" p={24} gap={12}>
  <Text size={18} weight="bold" color="#fff">Title</Text>
  <Text size={14} color="#a1a1aa" w="fill">Description text</Text>
  <Frame bg="#3b82f6" px={16} py={8} rounded={6}>
    <Text size={14} weight="medium" color="#fff">Button</Text>
  </Frame>
</Frame>'
```

### Common Pitfalls

**1. Text gets cut off (CRITICAL):**
```jsx
// BAD: Text without w="fill" will be single line and clip
<Frame flex="col" gap={8}>
  <Text size={16} weight="semibold" color="#fff">Title cut off</Text>
  <Text size={14} color="#a1a1aa">Description also cut off...</Text>
</Frame>

// GOOD: Add w="fill" to parent Frame AND ALL Text elements
<Frame flex="col" gap={8} w="fill">
  <Text size={16} weight="semibold" color="#fff" w="fill">Title wraps properly</Text>
  <Text size={14} color="#a1a1aa" w="fill">Description wraps properly.</Text>
</Frame>
```
**Rule:** For text to wrap, you need:
1. Parent frame with `w="fill"` or fixed width
2. **EVERY** Text element needs `w="fill"` (not just descriptions!)
3. Parent must have `flex="col"` or `flex="row"`

**IMPORTANT:** ALL text that could wrap needs `w="fill"`:
- Titles (e.g., "Wireless Noise-Canceling Headphones")
- Descriptions
- Labels
- Any multi-word text

**Real example - card with title AND description:**
```jsx
<Frame name="Card" w={340} bg="#18181b" rounded={16} flex="col" p={20} gap={16}>
  <Frame flex="col" gap={8} w="fill">
    <Text size={16} weight="semibold" color="#fff" w="fill">Wireless Noise-Canceling Headphones</Text>
    <Text size={14} color="#a1a1aa" w="fill">Premium audio experience with 40-hour battery life.</Text>
  </Frame>
</Frame>
```

**2. Toggle switches - use flex, not absolute:**
```jsx
// BAD: Absolute positioning for knob
<Frame w={52} h={28} bg="#3b82f6" rounded={14} p={2}>
  <Frame w={24} h={24} bg="#fff" rounded={12} position="absolute" x={26} y={2} />
</Frame>

// GOOD: Flex with justify for ON/OFF state
// ON state (knob right)
<Frame w={52} h={28} bg="#3b82f6" rounded={14} flex="row" items="center" p={2} justify="end">
  <Frame w={24} h={24} bg="#fff" rounded={12} />
</Frame>
// OFF state (knob left)
<Frame w={52} h={28} bg="#27272a" rounded={14} flex="row" items="center" p={2} justify="start">
  <Frame w={24} h={24} bg="#52525b" rounded={12} />
</Frame>
```

**3. Buttons need flex + fixed width for centered text:**
```jsx
// BAD: No flex, text not centered
<Frame bg="#3b82f6" px={16} py={10} rounded={10}>
  <Text>Button</Text>
</Frame>

// GOOD: Flex centers content
<Frame bg="#3b82f6" px={16} py={10} rounded={10} flex="row" justify="center" items="center">
  <Text>Button</Text>
</Frame>

// BEST (for components): Fixed width + auto-layout + text fills
<Frame w={100} h={40} bg="#3b82f6" rounded={8} flex="row" justify="center" items="center" px={16} py={10}>
  <Text color="#fff" w="fill" align="center">Button</Text>
</Frame>
```

**Button component pattern (for variants):**
```javascript
// When creating button components programmatically:
frame.layoutMode = "HORIZONTAL";
frame.primaryAxisSizingMode = "FIXED";    // Keep fixed width
frame.counterAxisSizingMode = "FIXED";    // Keep fixed height
frame.resize(100, 40);                     // Set size AFTER layout mode
frame.primaryAxisAlignItems = "CENTER";
frame.counterAxisAlignItems = "CENTER";
frame.paddingLeft = frame.paddingRight = 16;
frame.paddingTop = frame.paddingBottom = 10;

// Text inside button
text.textAlignHorizontal = "CENTER";
text.layoutAlign = "STRETCH";              // Fill available width
text.layoutGrow = 1;                       // Grow to fill
```

**4. No emojis - use real Lucide icons or shapes:**
```jsx
// BAD: Emojis render inconsistently
<Text>🏠</Text>

// BEST: Use real Lucide icons (fetched as SVG from Iconify API)
<Icon name="lucide:home" size={20} color="#fff" />
<Icon name="lucide:settings" size={20} color="var:foreground" />

// OK: Use shapes as fallback icon placeholders
<Frame w={20} h={20} rounded={4} stroke="#fff" strokeWidth={2} />  // square icon
<Frame w={20} h={20} rounded={10} stroke="#fff" strokeWidth={2} /> // circle icon
```

**5. Three-dot menu icon:**
```jsx
<Frame flex="row" gap={3} justify="center" items="center">
  <Frame w={4} h={4} bg="#52525b" rounded={2} />
  <Frame w={4} h={4} bg="#52525b" rounded={2} />
  <Frame w={4} h={4} bg="#52525b" rounded={2} />
</Frame>
```

**6. Star rating with shapes:**
```jsx
<Frame flex="row" gap={4}>
  <Frame w={14} h={14} bg="#fbbf24" rounded={2} />
  <Frame w={14} h={14} bg="#fbbf24" rounded={2} />
  <Frame w={14} h={14} bg="#fbbf24" rounded={2} />
  <Frame w={14} h={14} bg="#fbbf24" rounded={2} />
  <Frame w={14} h={14} bg="#fbbf24" rounded={2} />
</Frame>
```

---

## Key Rules

1. **Always use `render` for frames** - has smart positioning
2. **Never use `eval` to create** - no positioning, overlaps at (0,0)
3. **Never use `npx figma-use render`** - no smart positioning
4. **For multiple frames:** Use `render-batch`
5. **Convert to components:** `node to-component` after creation

---

## Onboarding ("Initiate Project")

**Never show terminal commands to users.** Run silently, give friendly feedback.

1. Run `npm install` silently
2. Ask connection mode (Yolo or Safe)
3. Run `node src/index.js connect` (or `--safe`)
4. When connected, say: "Connected! What would you like to create?"

If permission error (macOS): System Settings → Privacy → Full Disk Access → Add Terminal

---

## Variable Visualization

"Show colors on canvas" / "display variables" / "create palette":
```bash
node src/index.js var visualize              # All collections
node src/index.js var visualize "primitives" # Filter
```

Creates shadcn-style color swatches bound to variables.

---

## Website Recreation

```bash
node src/index.js recreate-url "https://example.com" --name "Page"
node src/index.js screenshot-url "https://example.com"
```

---

## Speed Daemon

`connect` auto-starts daemon for 10x faster commands.

```bash
node src/index.js daemon status
node src/index.js daemon restart
```
