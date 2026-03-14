# figma-ds-cli Command Reference

Full command reference for the Figma CLI. For quick start, see GEMINI.md.

## Design Tokens & Variables

### Create Design Systems

```bash
node src/index.js tokens ds              # IDS Base colors
node src/index.js tokens tailwind        # Tailwind 22 color families (242 vars)
node src/index.js tokens spacing         # Spacing tokens
```

### Manage Variables

```bash
node src/index.js var list               # Show all variables
node src/index.js var list -t COLOR      # Filter by type
node src/index.js var visualize          # Show colors on canvas
node src/index.js var create "name" -c "ColId" -t COLOR -v "#3b82f6"
```

### Bind Variables

```bash
node src/index.js bind fill "primary/500"
node src/index.js bind stroke "border/default"
node src/index.js bind radius "radius/md"
node src/index.js bind gap "spacing/md"
node src/index.js bind padding "spacing/lg"
node src/index.js bind list              # List available variables
```

## Create Elements

### Quick Primitives

```bash
node src/index.js create rect "Card" -w 320 -h 200 --fill "#fff" --radius 12
node src/index.js create circle "Avatar" -w 48 --fill "#3b82f6"
node src/index.js create text "Hello" -s 24 -c "#000" -w bold
node src/index.js create line -l 200 -c "#e4e4e7"
node src/index.js create autolayout "Card" -d col -g 16 -p 24 --fill "#fff"
node src/index.js create icon lucide:star -s 24 -c "#f59e0b"
node src/index.js create image "https://example.com/photo.png" -w 200
node src/index.js create group "Header"
node src/index.js create component "Button"
```

### Create with Variable Binding (Fast)

Use `var:name` syntax to bind shadcn variables at creation time:

```bash
node src/index.js create rect "Card" --fill "var:card" --stroke "var:border"
node src/index.js create circle "Avatar" --fill "var:primary"
node src/index.js create text "Hello" -c "var:foreground"
node src/index.js create line -c "var:border"
node src/index.js create frame "Section" --fill "var:background"
node src/index.js create autolayout "Container" --fill "var:muted"
node src/index.js create icon lucide:star -c "var:primary"
```

### Render with JSX

```bash
node src/index.js render '<Frame name="Card" w={320} h={180} bg="#fff" rounded={16} flex="col" gap={8} p={24}>
  <Text size={20} weight="bold" color="#111">Title</Text>
  <Text size={14} color="#666" w="fill">Description</Text>
</Frame>'
```

### Render with Variable Binding (Fast)

Use `var:name` syntax to bind shadcn variables at creation time (no separate bind commands needed):

```bash
node src/index.js render '<Frame name="Card" w={320} h={180} bg="var:card" stroke="var:border" rounded={16} flex="col" gap={8} p={24}>
  <Text size={20} weight="bold" color="var:foreground">Title</Text>
  <Text size={14} color="var:muted-foreground" w="fill">Description</Text>
  <Frame bg="var:primary" px={16} py={8} rounded={8}>
    <Text color="var:primary-foreground">Button</Text>
  </Frame>
</Frame>'
```

Variables: `background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `accent`, `border`, and their `-foreground` variants.

### Render Batch (Multiple Frames)

```bash
node src/index.js render-batch '[
  "<Frame name=\"Card 1\" w={300} h={200} bg=\"#fff\"><Text>Card 1</Text></Frame>",
  "<Frame name=\"Card 2\" w={300} h={200} bg=\"#fff\"><Text>Card 2</Text></Frame>"
]' -d row -g 40
```

Options: `-d row|col` (direction), `-g <n>` (gap)

## Modify Elements

```bash
node src/index.js set fill "#3b82f6"           # Change fill (hex)
node src/index.js set fill "var:primary"       # Bind fill to variable (fast)
node src/index.js set fill "#3b82f6" -n "1:234" # On specific node
node src/index.js set stroke "#e4e4e7" -w 1    # Add stroke (hex)
node src/index.js set stroke "var:border"      # Bind stroke to variable
node src/index.js set radius 12                # Corner radius
node src/index.js set size 320 200             # Resize
node src/index.js set pos 100 100              # Move
node src/index.js set opacity 0.5              # Opacity
node src/index.js set autolayout row -g 8 -p 16 # Apply auto-layout
node src/index.js set name "Header"            # Rename
```

## Layout & Sizing

```bash
node src/index.js sizing hug                   # Hug contents
node src/index.js sizing fill                  # Fill container
node src/index.js sizing fixed 320 200         # Fixed size
node src/index.js padding 16                   # All sides
node src/index.js padding 16 24                # Vertical, horizontal
node src/index.js gap 16                       # Set gap
node src/index.js align center                 # Align items
```

## Find & Select

```bash
node src/index.js find "Button"                # Find by name
node src/index.js find "Card" -t FRAME         # Filter by type
node src/index.js select "1:234"               # Select node
node src/index.js get                          # Get selection props
node src/index.js get "1:234"                  # Get specific node
```

## Canvas Operations

```bash
node src/index.js canvas info                  # What's on canvas
node src/index.js canvas next                  # Next free position
node src/index.js arrange -g 100               # Arrange frames
node src/index.js arrange -g 100 -c 3          # 3 columns
```

## Duplicate & Delete

```bash
node src/index.js duplicate                    # Duplicate selection
node src/index.js dup "1:234" --offset 50      # With offset
node src/index.js delete                       # Delete selection
node src/index.js delete "1:234"               # Delete by ID
```

## Node Operations

```bash
node src/index.js node tree                    # Show tree structure
node src/index.js node tree "1:234" -d 5       # Deeper depth
node src/index.js node bindings                # Show variable bindings
node src/index.js node to-component "1:234"    # Convert to component
node src/index.js node delete "1:234"          # Delete by ID
```

## Slots

Figma's native slots feature for flexible content areas in components.

```bash
node src/index.js slot create "Content"        # Create slot on component
node src/index.js slot create "Actions" --flex row --gap 8 --padding 16
node src/index.js slot list                    # List slots in component
node src/index.js slot list "1:234"            # List by component ID
node src/index.js slot preferred "Slot#1:2" "comp-id-1" "comp-id-2"  # Set preferred
node src/index.js slot reset                   # Reset slot to defaults
node src/index.js slot add "slot-id" --component "comp-id"  # Add to slot
node src/index.js slot add "slot-id" --frame   # Add empty frame
node src/index.js slot add "slot-id" --text "Hello"  # Add text
```

## Export

```bash
node src/index.js export css                   # Variables as CSS
node src/index.js export tailwind              # Tailwind config
node src/index.js export screenshot -o out.png # Screenshot (selection or page)
node src/index.js export screenshot -s 2 -f png # 2x scale PNG
node src/index.js export screenshot -f svg     # SVG format
node src/index.js export node "1:234" -o card.png         # Export node by ID
node src/index.js export node "1:234" -s 2 -f png         # 2x scale PNG
node src/index.js export node "1:234" -f svg -o card.svg  # SVG export
node src/index.js export-jsx "1:234"           # Export as JSX
node src/index.js export-jsx "1:234" -o Card.jsx --pretty
node src/index.js export-storybook "1:234"     # Storybook stories
```

## Analysis & Linting

```bash
node src/index.js lint                         # Check all rules
node src/index.js lint --fix                   # Auto-fix
node src/index.js lint --rule color-contrast   # Specific rule
node src/index.js lint --preset accessibility  # Use preset
node src/index.js analyze colors               # Color usage
node src/index.js analyze typography           # Typography
node src/index.js analyze spacing              # Spacing
node src/index.js analyze clusters             # Find patterns
```

Lint rules: `no-default-names`, `no-deeply-nested`, `no-empty-frames`, `prefer-auto-layout`, `no-hardcoded-colors`, `color-contrast`, `touch-target-size`, `min-text-size`

Presets: `recommended`, `strict`, `accessibility`, `design-system`

## XPath Queries

```bash
node src/index.js raw query "//FRAME"
node src/index.js raw query "//COMPONENT"
node src/index.js raw query "//*[contains(@name, 'Button')]"
node src/index.js raw select "1:234"
node src/index.js raw export "1:234" --scale 2
```

## Website Recreation

```bash
node src/index.js recreate-url "https://example.com" --name "My Page"
node src/index.js recreate-url "https://example.com" -w 375 -h 812  # Mobile
node src/index.js analyze-url "https://example.com" --screenshot
node src/index.js screenshot-url "https://example.com" --full
```

## Images

```bash
node src/index.js create image "https://example.com/photo.png"
node src/index.js screenshot-url "https://example.com"
node src/index.js remove-bg                    # Remove background (needs API key)
```

## FigJam

```bash
node src/index.js fj list                      # List pages
node src/index.js fj sticky "Text" -x 100 -y 100 --color "#FEF08A"
node src/index.js fj shape "Label" -x 200 -y 100 -w 200 -h 100
node src/index.js fj connect "ID1" "ID2"       # Connect elements
node src/index.js fj nodes                     # Show elements
node src/index.js fj delete "ID"
node src/index.js fj eval "figma.currentPage.children.length"
```

Shape types: `ROUNDED_RECTANGLE`, `RECTANGLE`, `ELLIPSE`, `DIAMOND`, `TRIANGLE_UP`, `TRIANGLE_DOWN`, `PARALLELOGRAM_RIGHT`, `PARALLELOGRAM_LEFT`

## Daemon & Connection

```bash
node src/index.js connect                  # Connect (Yolo Mode)
node src/index.js connect --safe           # Connect (Safe Mode, plugin)
node src/index.js daemon status            # Check daemon status
node src/index.js daemon status --debug    # Detailed token & connection info
node src/index.js daemon diagnose          # Full diagnostic (troubleshooting)
node src/index.js daemon start             # Start daemon manually
node src/index.js daemon start --force     # Force restart
node src/index.js daemon restart           # Restart with fresh token
node src/index.js daemon stop              # Stop daemon
node src/index.js daemon reconnect         # Reconnect to Figma
node src/index.js files                    # List open Figma files (JSON)
```

### Troubleshooting Auth Errors

If you see "Unauthorized: Invalid or missing token":

```bash
node src/index.js daemon diagnose          # See what's wrong
node src/index.js daemon restart           # Usually fixes it
```

Token file location: `~/.figma-ds-cli/.daemon-token`

## Component Combinations (combos)

Generate all variant combinations as individual components:

```bash
node src/index.js combos                   # Use selection
node src/index.js combos "1:234"           # By node ID
node src/index.js combos --dry-run         # Preview without creating
node src/index.js combos --gap 60          # Custom gap between components
node src/index.js combos --no-boolean      # Exclude boolean properties
```

**How it works:**
1. Select a component set (or any variant/instance)
2. Run `combos` to generate all combinations
3. Creates **individual components** directly on canvas (no container frame)
4. Each component named: `Button/Small/Default`, `Button/Small/Hover`, etc.
5. Arranged in a grid (last property = columns, rest = rows)
6. Row/column labels added automatically (use `--no-labels` to skip)

## Size Variants (sizes)

Generate Small/Medium/Large variants from a single component:

```bash
node src/index.js sizes                       # Use selection
node src/index.js sizes "1:234"               # By node ID
node src/index.js sizes --base small          # Source is Small size
node src/index.js sizes --base large          # Source is Large size
node src/index.js sizes --gap 60              # Custom gap
```

**How it works:**
1. Select a component or frame
2. Run `sizes --base <size>` to specify which size it is
3. Creates Small, Medium, Large variants with proportional scaling
4. Scales: dimensions, font sizes, padding, corner radius, gaps

## JavaScript Eval

```bash
node src/index.js eval "figma.currentPage.name"
node src/index.js eval --file /tmp/script.js
node src/index.js run /tmp/script.js
```

## Render JSX Syntax

**Elements:** `<Frame>`, `<Rectangle>`, `<Ellipse>`, `<Text>`, `<Line>`, `<Image>`, `<SVG>`, `<Icon>`

**Size:** `w={320} h={200}`, `w="fill"`, `minW={100} maxW={500}`

**Layout:** `flex="row|col"`, `gap={16}`, `wrap={true}`, `justify="start|center|end|between"`, `items="start|center|end"`

**Padding:** `p={24}`, `px={16} py={8}`, `pt={8} pr={16} pb={8} pl={16}`

**Appearance:** `bg="#fff"`, `stroke="#000"`, `strokeWidth={1}`, `opacity={0.5}`

**Corners:** `rounded={16}`, `roundedTL={8}`, `overflow="hidden"`

**Effects:** `shadow="0 4 12 #0001"`, `blur={10}`, `rotate={45}`

**Text:** `<Text size={18} weight="bold" color="#000" font="Inter">Hello</Text>`

**WRONG vs RIGHT:**
```
layout="horizontal"  →  flex="row"
padding={24}         →  p={24}
fill="#fff"          →  bg="#fff"
cornerRadius={12}    →  rounded={12}
```

## Advanced Examples

### Switch to Dark Mode
```javascript
node src/index.js eval "
const node = figma.getNodeById('1:234');
function findModeCollection(n) {
  if (n.boundVariables) {
    for (const [prop, binding] of Object.entries(n.boundVariables)) {
      const b = Array.isArray(binding) ? binding[0] : binding;
      if (b && b.id) {
        const variable = figma.variables.getVariableById(b.id);
        if (variable) {
          const col = figma.variables.getVariableCollectionById(variable.variableCollectionId);
          if (col && col.modes.length > 1) return { col, modes: col.modes };
        }
      }
    }
  }
  if (n.children) {
    for (const c of n.children) {
      const found = findModeCollection(c);
      if (found) return found;
    }
  }
  return null;
}
const found = findModeCollection(node);
if (found) {
  const darkMode = found.modes.find(m => m.name.includes('Dark'));
  if (darkMode) node.setExplicitVariableModeForCollection(found.col, darkMode.modeId);
}
"
```

### Create Component Instance
```javascript
node src/index.js eval "(function() {
  const comp = figma.currentPage.findOne(n => n.type === 'COMPONENT' && n.name === 'Button');
  if (!comp) return 'Component not found';
  const instance = comp.createInstance();
  instance.x = 100;
  instance.y = 100;
  return instance.id;
})()"
```

### Smart Positioning
```javascript
let smartX = 0;
figma.currentPage.children.forEach(n => { smartX = Math.max(smartX, n.x + n.width); });
smartX += 100;
const frame = figma.createFrame();
frame.x = smartX;
```

## Safe Mode

Safe Mode uses a plugin-based connection instead of CDP (Chrome DevTools Protocol). Use it when:
- Company MacBook with restricted privacy settings
- Full Disk Access permission not available
- Prefer no Figma modification

### Connection
```bash
node src/index.js connect --safe
```

Then in Figma: Plugins → Development → FigCli

### Differences from Yolo Mode

| Feature | Yolo Mode | Safe Mode |
|---------|-----------|-----------|
| Connection | Direct CDP | Plugin bridge |
| Setup | Patches Figma once | Start plugin each session |
| Speed | ~10x faster | Standard |
| Timeout | 60 seconds | 60 seconds |

### Command Support

All commands work in both modes. In Safe Mode, commands use native Figma API instead of figma-use:

| Command | Yolo Mode | Safe Mode |
|---------|-----------|-----------|
| `render` | figma-use | daemon (native API) |
| `render-batch` | figma-use | daemon (native API) |
| `node to-component` | figma-use | native API |
| `node delete` | figma-use | native API |
| `node tree` | figma-use | native API |
| `node bindings` | figma-use | native API |
| `lint` | figma-use | native API |
| `analyze colors/typography/spacing/clusters` | figma-use | native API |
| `export-jsx` | figma-use | native API |
| `export-storybook` | figma-use | native API |
| All other commands | daemon | daemon |

### Tips for Safe Mode

1. **Keep payloads smaller**: Break complex screens into multiple `render` calls
2. **All commands work**: Native implementations match figma-use functionality
3. **Timeout**: Both modes now have 60s timeout

### When render-batch fails

If `render-batch` times out with complex JSX, break it up:

```bash
# Instead of one large batch
node src/index.js render-batch '[huge array]'

# Use multiple smaller batches
node src/index.js render '<Frame>...</Frame>'
node src/index.js render '<Frame>...</Frame>'
```

Or use `eval` with native Figma API for maximum control (see "Complex Components" in GEMINI.md).
