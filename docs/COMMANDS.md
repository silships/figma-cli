# Commands Reference

## FigJam Commands

FigJam has its own command group with direct CDP connection (bypasses figma-use):

```bash
# List open FigJam pages
figma-ds-cli figjam list
figma-ds-cli fj list  # alias

# Show page info
figma-ds-cli fj info

# List elements on page
figma-ds-cli fj nodes
figma-ds-cli fj nodes --limit 50

# Create sticky note
figma-ds-cli fj sticky "Hello World!" -x 100 -y 100
figma-ds-cli fj sticky "Yellow Note" -x 200 -y 100 --color "#FEF08A"

# Create shape with text
figma-ds-cli fj shape "Box Label" -x 100 -y 200 -w 200 -h 100
figma-ds-cli fj shape "Diamond" -x 300 -y 200 --type DIAMOND

# Create text
figma-ds-cli fj text "Plain text" -x 100 -y 400 --size 24

# Connect two nodes
figma-ds-cli fj connect "2:30" "2:34"

# Move a node
figma-ds-cli fj move "2:30" 500 500

# Update text content
figma-ds-cli fj update "2:30" "New text content"

# Delete a node
figma-ds-cli fj delete "2:30"

# Execute JavaScript in FigJam
figma-ds-cli fj eval "figma.currentPage.children.length"
```

### Shape Types

- `ROUNDED_RECTANGLE` (default)
- `RECTANGLE`
- `ELLIPSE`
- `DIAMOND`
- `TRIANGLE_UP`
- `TRIANGLE_DOWN`
- `PARALLELOGRAM_RIGHT`
- `PARALLELOGRAM_LEFT`

### Page Selection

All FigJam commands support `-p` or `--page` to target a specific page:

```bash
figma-ds-cli fj sticky "Note" -p "My Board" -x 100 -y 100
```

---

## Setup & Connection

```bash
# Initial setup (patches Figma, installs dependencies)
figma-ds-cli

# Connect to running Figma
figma-ds-cli connect
```

## Design Tokens

```bash
# IDS Base Design System (71 variables, 5 collections)
figma-ds-cli tokens ds

# Tailwind CSS colors (220 variables)
figma-ds-cli tokens tailwind

# Spacing scale (4px base)
figma-ds-cli tokens spacing

# Border radii
figma-ds-cli tokens radii
```

## Design Export (extract)

Scan the open Figma file and write a DESIGN.md — tokens, structure, component
variant matrices. Output is readable by `figma-cli import` (full roundtrip).
Verified against Primer Web (Community): 67 pages, ~124k nodes, one daemon
call per page. Component sets become variant-property matrices.

```bash
# Export the full file — all pages, all 11 sections (default output: ./DESIGN.md)
figma-cli extract

# Custom output path
figma-cli extract my-system.md

# Only specific pages (case-insensitive substring match)
figma-cli extract --pages "Button,ActionMenu"

# Only the currently selected nodes
figma-cli extract --selection

# Only specific sections (comma list)
# Sections: identity, structure, color, typography, spacing,
#           depth, components, states, rules, extending, tokens
figma-cli extract --sections tokens
figma-cli extract --sections color,typography,tokens

# Also write full per-page trees to DESIGN-structure/ alongside the main file
figma-cli extract --split

# Flags can combine
figma-cli extract output.md --pages "Icons" --sections structure,tokens --split
```

Re-import the output at any time:

```bash
figma-cli import DESIGN.md
```

## Variables

```bash
# List all variables
figma-ds-cli var list

# Create a variable
figma-ds-cli var create "primary/500" -c "CollectionId" -t COLOR -v "#3b82f6"

# Find variables by pattern
figma-ds-cli var find "primary/*"
```

## Collections

```bash
# List collections
figma-ds-cli col list

# Create collection
figma-ds-cli col create "Color - Semantic"
```

## Create Elements

```bash
# Create a frame
figma-ds-cli create frame "Card" -w 320 -h 200 --fill "#ffffff" --radius 12

# Create an icon (Iconify, 150k+ icons)
figma-ds-cli create icon lucide:star -s 24 -c "#f59e0b"
figma-ds-cli create icon mdi:home -s 32 -c "#3b82f6"
```

## JSX Rendering

```bash
# Create complex UI from JSX
figma-ds-cli render '<Frame w={320} h={200} bg="#fff" rounded={12} p={24} flex="col" gap={16}>
  <Text size={18} weight="bold" color="#111">Card Title</Text>
  <Text size={14} color="#666">Description</Text>
</Frame>'
```

## Export

```bash
# Screenshot current view
figma-ds-cli export screenshot -o screenshot.png

# Export variables as CSS custom properties
figma-ds-cli export css

# Export as Tailwind config
figma-ds-cli export tailwind
```

## Raw Commands

```bash
# Execute arbitrary JavaScript
figma-ds-cli eval "figma.currentPage.name"

# Run figma-use commands directly
figma-ds-cli raw query "//COMPONENT"
figma-ds-cli raw lint
figma-ds-cli raw select "1:234"
figma-ds-cli raw export "1:234" --scale 2
```

## Query Syntax

The query command uses XPath-like syntax:

```bash
# All frames
figma-ds-cli raw query "//FRAME"

# Frames with specific name
figma-ds-cli raw query "//FRAME[@name='Card']"

# All components
figma-ds-cli raw query "//COMPONENT"

# All groups
figma-ds-cli raw query "//GROUP"

# Name starts with
figma-ds-cli raw query "//*[@name^='session-']"

# Name contains
figma-ds-cli raw query "//*[contains(@name, 'Button')]"
```

## Selection

```bash
# Select by ID
figma-ds-cli raw select "1:234"

# Select multiple
figma-ds-cli raw select "1:234,1:235,1:236"

# Clear selection
figma-ds-cli eval "figma.currentPage.selection = []"
```

## Export Nodes

```bash
# Export at 2x scale
figma-ds-cli raw export "1:234" --scale 2

# Export with suffix
figma-ds-cli raw export "1:234" --scale 2 --suffix "_dark"
```
