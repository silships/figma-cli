# Figma CLI Memory

## Key Files
- `src/figma-client.js` - Core JSX parser, code generator, Figma API wrapper
- `src/index.js` - CLI entry point, all commands
- See detailed docs: [figma-plugin-api.md](figma-plugin-api.md), [bugs-and-fixes.md](bugs-and-fixes.md)

## Critical Patterns

### Variable Binding
- Collections named `shadcn/primitives` and `shadcn/semantic` (NOT just `shadcn`)
- Use `c.name.startsWith('shadcn')` to find all shadcn collections
- `setBoundVariableForPaint(paint, 'color', variable)` returns new paint, must assign to fills
- Fallback color `rgb(0.5, 0.5, 0.5)` = gray when variable not found

### Auto-Layout Sizing (Root Frame)
- VERTICAL layout: primary axis = height, counter axis = width
- HORIZONTAL layout: primary axis = width, counter axis = height
- No explicit `h` on vertical frame = HUG content (primaryAxisSizingMode='AUTO')
- No explicit `w` on horizontal frame = HUG content
- Explicit `h`/`w` = FIXED sizing

### Auto-Layout Sizing (Children)
- `layoutSizingHorizontal`/`layoutSizingVertical`: 'FIXED' | 'HUG' | 'FILL'
- MUST set AFTER `appendChild()` - setting before throws error
- `grow={1}` maps to FILL on parent's flex direction
- `w="fill"` maps to `layoutSizingHorizontal = 'FILL'`

### Text Wrapping
- Parent AND every Text element needs `w="fill"`
- Parent must have `flex="col"` or `flex="row"`
- Font must be loaded before setting characters

### JSX Parser
- Parse open/close Frame tags first, then self-closing outside consumed ranges
- `frameOpenRegex` must skip self-closing (`match[0].endsWith('/')`)
- `extractContent` uses non-greedy `[^>]*?` to avoid eating `/` in `/>`

### Icons (Lucide via Iconify)
- `<Icon name="lucide:icon-name" size={16} color="var:foreground" />`
- SVGs pre-fetched on Node.js side from Iconify API, embedded in generated Figma code
- Uses `figma.createNodeFromSvg()` for real SVG rendering (not placeholder rectangles)
- Supports `var:` color binding (colorizes all fills/strokes in SVG tree)
- 11 icons used in shadcn components: check, chevron-left/right/down/up, x, plus, bold, ellipsis, info, alert-circle

## Two Code Paths
1. **render-batch** (~line 374): No var: support, uses `primaryAxisSizingMode`/`counterAxisSizingMode`
2. **single render with var:** (~line 783): Full var: support, uses `layoutSizingHorizontal`/`layoutSizingVertical` for children

## Key Gotchas (from API docs)
- `layoutWrap = 'WRAP'` only works on HORIZONTAL, throws on VERTICAL
- STRETCH + AUTO conflict: auto-layout child with STRETCH must have FIXED sizing
- Fills/strokes are immutable arrays: clone, modify, reassign
- `createComponentFromNode()` fails if node is inside Component/ComponentSet/Instance
- Setting `layoutMode = 'NONE'` does NOT restore original child positions
- `SPACE_BETWEEN` works on `primaryAxisAlignItems` (check JSX mapping)
- Component property names get `#uniqueId` suffix (e.g., `ButtonText#0:1`)

## Remote Setup
- `origin` = figma-cli-private (github.com/silships/figma-cli-private)
- `public` = figma-cli (github.com/silships/figma-cli)
- Always push to both
