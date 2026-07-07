# DESIGN.md -- test-claude code

<!-- extraction-meta
source: Figma file "test-claude code"
scope: 1 page(s)
date: 2026-07-02
nodes-scanned: 38
generator: figma-cli extract
-->

## 1. Identity

**In one line:** A design system using Inter with 7 unique colors extracted directly from Figma.

**Signature Techniques:**
- Consistent auto-layout spacing system
- Component library with 15 variants across 1 component sets

## 2. Structure

High-level composition. Each entry: frame name, type, dimensions, auto-layout.

### Page: Page 1

_4 top-level frame(s)_

- **CDP Yolo Test** · `FRAME` · 240×120
- **Daemon Render Test** · `FRAME` · 200×80 · horizontal row · 1 children
  - **It works** · `TEXT` · 63×19 · “It works”
- **Browser Yolo works** · `FRAME` · 280×110 · vertical stack, gap 4px · 2 children
  - **Browser Yolo works** · `TEXT` · 280×22 · “Browser Yolo works”
  - **no plugin · no desktop · no token** · `TEXT` · 280×15 · “no plugin · no desktop · no token”
- **Button** · `COMPONENT_SET` · 1715×43 · 15 children
  - **Variant=Default, Size=Small** · `COMPONENT` · 63×27 · horizontal row, gap 6px, padding 6/12/6/12px · 1 children
    - **Button** · `TEXT` · 39×15 · “Button”

## 3. Color

### Palette

| Token | Hex | Usage count |
|---|---|---|
| background | `#ffffff` | 2 |
| accent | `#3b82f5` | 1 |
| accent-alt | `#22c55e` | 1 |
| accent-3 | `#8b5cf6` | 1 |
| surface | `#ede9fe` | 1 |
| text-primary | `#18181b` | 1 |
| background-alt | `#fafafa` | 1 |

## 4. Variables

Real Figma variable collections — the authoritative tokens (names, modes, values). These come straight from the file, unlike the sampled palette above. `figma-cli import` can recreate them as variables.

### Collection: shadcn/primitives  ·  244 variables  ·  modes: Mode 1

| Variable | Type | Mode 1 |
|---|---|---|
| slate/50 | COLOR | `#f8fafc` |
| slate/100 | COLOR | `#f1f5f9` |
| slate/200 | COLOR | `#e2e8f0` |
| slate/300 | COLOR | `#cbd5e1` |
| slate/400 | COLOR | `#94a3b8` |
| slate/500 | COLOR | `#64748b` |
| slate/600 | COLOR | `#475569` |
| slate/700 | COLOR | `#334155` |
| slate/800 | COLOR | `#1e293b` |
| slate/900 | COLOR | `#0f172a` |
| slate/950 | COLOR | `#020617` |
| gray/50 | COLOR | `#f9fafb` |
| gray/100 | COLOR | `#f3f4f6` |
| gray/200 | COLOR | `#e5e7eb` |
| gray/300 | COLOR | `#d1d5db` |
| gray/400 | COLOR | `#9ca3af` |
| gray/500 | COLOR | `#6b7280` |
| gray/600 | COLOR | `#4b5563` |
| gray/700 | COLOR | `#374151` |
| gray/800 | COLOR | `#1f2937` |
| gray/900 | COLOR | `#111827` |
| gray/950 | COLOR | `#030712` |
| zinc/50 | COLOR | `#fafafa` |
| zinc/100 | COLOR | `#f4f4f5` |
| zinc/200 | COLOR | `#e4e4e7` |
| zinc/300 | COLOR | `#d4d4d8` |
| zinc/400 | COLOR | `#a1a1aa` |
| zinc/500 | COLOR | `#71717a` |
| zinc/600 | COLOR | `#52525b` |
| zinc/700 | COLOR | `#3f3f46` |
| zinc/800 | COLOR | `#27272a` |
| zinc/900 | COLOR | `#18181b` |
| zinc/950 | COLOR | `#09090b` |
| neutral/50 | COLOR | `#fafafa` |
| neutral/100 | COLOR | `#f5f5f5` |
| neutral/200 | COLOR | `#e5e5e5` |
| neutral/300 | COLOR | `#d4d4d4` |
| neutral/400 | COLOR | `#a3a3a3` |
| neutral/500 | COLOR | `#737373` |
| neutral/600 | COLOR | `#525252` |
| neutral/700 | COLOR | `#404040` |
| neutral/800 | COLOR | `#262626` |
| neutral/900 | COLOR | `#171717` |
| neutral/950 | COLOR | `#0a0a0a` |
| stone/50 | COLOR | `#fafaf9` |
| stone/100 | COLOR | `#f5f5f4` |
| stone/200 | COLOR | `#e7e5e4` |
| stone/300 | COLOR | `#d6d3d1` |
| stone/400 | COLOR | `#a8a29e` |
| stone/500 | COLOR | `#78716c` |
| stone/600 | COLOR | `#57534e` |
| stone/700 | COLOR | `#44403c` |
| stone/800 | COLOR | `#292524` |
| stone/900 | COLOR | `#1c1917` |
| stone/950 | COLOR | `#0c0a09` |
| red/50 | COLOR | `#fef2f2` |
| red/100 | COLOR | `#fee2e2` |
| red/200 | COLOR | `#fecaca` |
| red/300 | COLOR | `#fca5a5` |
| red/400 | COLOR | `#f87171` |
| red/500 | COLOR | `#ef4444` |
| red/600 | COLOR | `#dc2626` |
| red/700 | COLOR | `#b91c1c` |
| red/800 | COLOR | `#991b1b` |
| red/900 | COLOR | `#7f1d1d` |
| red/950 | COLOR | `#450a0a` |
| orange/50 | COLOR | `#fff7ed` |
| orange/100 | COLOR | `#ffedd5` |
| orange/200 | COLOR | `#fed7aa` |
| orange/300 | COLOR | `#fdba74` |
| orange/400 | COLOR | `#fb923c` |
| orange/500 | COLOR | `#f97316` |
| orange/600 | COLOR | `#ea580c` |
| orange/700 | COLOR | `#c2410c` |
| orange/800 | COLOR | `#9a3412` |
| orange/900 | COLOR | `#7c2d12` |
| orange/950 | COLOR | `#431407` |
| amber/50 | COLOR | `#fffbeb` |
| amber/100 | COLOR | `#fef3c7` |
| amber/200 | COLOR | `#fde68a` |
| amber/300 | COLOR | `#fcd34d` |
| amber/400 | COLOR | `#fbbf24` |
| amber/500 | COLOR | `#f59e0b` |
| amber/600 | COLOR | `#d97706` |
| amber/700 | COLOR | `#b45309` |
| amber/800 | COLOR | `#92400e` |
| amber/900 | COLOR | `#78350f` |
| amber/950 | COLOR | `#451a03` |
| yellow/50 | COLOR | `#fefce8` |
| yellow/100 | COLOR | `#fef9c3` |
| yellow/200 | COLOR | `#fef08a` |
| yellow/300 | COLOR | `#fde047` |
| yellow/400 | COLOR | `#facc15` |
| yellow/500 | COLOR | `#eab308` |
| yellow/600 | COLOR | `#ca8a04` |
| yellow/700 | COLOR | `#a16207` |
| yellow/800 | COLOR | `#854d0e` |
| yellow/900 | COLOR | `#713f12` |
| yellow/950 | COLOR | `#422006` |
| lime/50 | COLOR | `#f7fee7` |
| lime/100 | COLOR | `#ecfccb` |
| lime/200 | COLOR | `#d9f99d` |
| lime/300 | COLOR | `#bef264` |
| lime/400 | COLOR | `#a3e635` |
| lime/500 | COLOR | `#84cc16` |
| lime/600 | COLOR | `#65a30d` |
| lime/700 | COLOR | `#4d7c0f` |
| lime/800 | COLOR | `#3f6212` |
| lime/900 | COLOR | `#365314` |
| lime/950 | COLOR | `#1a2e05` |
| green/50 | COLOR | `#f0fdf4` |
| green/100 | COLOR | `#dcfce7` |
| green/200 | COLOR | `#bbf7d0` |
| green/300 | COLOR | `#86efac` |
| green/400 | COLOR | `#4ade80` |
| green/500 | COLOR | `#22c55e` |
| green/600 | COLOR | `#16a34a` |
| green/700 | COLOR | `#15803d` |
| green/800 | COLOR | `#166534` |
| green/900 | COLOR | `#14532d` |
| green/950 | COLOR | `#052e16` |
| emerald/50 | COLOR | `#ecfdf5` |
| emerald/100 | COLOR | `#d1fae5` |
| emerald/200 | COLOR | `#a7f3d0` |
| emerald/300 | COLOR | `#6ee7b7` |
| emerald/400 | COLOR | `#34d399` |
| emerald/500 | COLOR | `#10b981` |
| emerald/600 | COLOR | `#059669` |
| emerald/700 | COLOR | `#047857` |
| emerald/800 | COLOR | `#065f46` |
| emerald/900 | COLOR | `#064e3b` |
| emerald/950 | COLOR | `#022c22` |
| teal/50 | COLOR | `#f0fdfa` |
| teal/100 | COLOR | `#ccfbf1` |
| teal/200 | COLOR | `#99f6e4` |
| teal/300 | COLOR | `#5eead4` |
| teal/400 | COLOR | `#2dd4bf` |
| teal/500 | COLOR | `#14b8a6` |
| teal/600 | COLOR | `#0d9488` |
| teal/700 | COLOR | `#0f766e` |
| teal/800 | COLOR | `#115e59` |
| teal/900 | COLOR | `#134e4a` |
| teal/950 | COLOR | `#042f2e` |
| cyan/50 | COLOR | `#ecfeff` |
| cyan/100 | COLOR | `#cffafe` |
| cyan/200 | COLOR | `#a5f3fc` |
| cyan/300 | COLOR | `#67e8f9` |
| cyan/400 | COLOR | `#22d3ee` |
| cyan/500 | COLOR | `#06b6d4` |
| cyan/600 | COLOR | `#0891b2` |
| cyan/700 | COLOR | `#0e7490` |
| cyan/800 | COLOR | `#155e75` |
| cyan/900 | COLOR | `#164e63` |
| cyan/950 | COLOR | `#083344` |
| sky/50 | COLOR | `#f0f9ff` |
| sky/100 | COLOR | `#e0f2fe` |
| sky/200 | COLOR | `#bae6fd` |
| sky/300 | COLOR | `#7dd3fc` |
| sky/400 | COLOR | `#38bdf8` |
| sky/500 | COLOR | `#0ea5e9` |
| sky/600 | COLOR | `#0284c7` |
| sky/700 | COLOR | `#0369a1` |
| sky/800 | COLOR | `#075985` |
| sky/900 | COLOR | `#0c4a6e` |
| sky/950 | COLOR | `#082f49` |
| blue/50 | COLOR | `#eff6ff` |
| blue/100 | COLOR | `#dbeafe` |
| blue/200 | COLOR | `#bfdbfe` |
| blue/300 | COLOR | `#93c5fd` |
| blue/400 | COLOR | `#60a5fa` |
| blue/500 | COLOR | `#3b82f6` |
| blue/600 | COLOR | `#2563eb` |
| blue/700 | COLOR | `#1d4ed8` |
| blue/800 | COLOR | `#1e40af` |
| blue/900 | COLOR | `#1e3a8a` |
| blue/950 | COLOR | `#172554` |
| indigo/50 | COLOR | `#eef2ff` |
| indigo/100 | COLOR | `#e0e7ff` |
| indigo/200 | COLOR | `#c7d2fe` |
| indigo/300 | COLOR | `#a5b4fc` |
| indigo/400 | COLOR | `#818cf8` |
| indigo/500 | COLOR | `#6366f1` |
| indigo/600 | COLOR | `#4f46e5` |
| indigo/700 | COLOR | `#4338ca` |
| indigo/800 | COLOR | `#3730a3` |
| indigo/900 | COLOR | `#312e81` |
| indigo/950 | COLOR | `#1e1b4b` |
| violet/50 | COLOR | `#f5f3ff` |
| violet/100 | COLOR | `#ede9fe` |
| violet/200 | COLOR | `#ddd6fe` |
| violet/300 | COLOR | `#c4b5fd` |
| violet/400 | COLOR | `#a78bfa` |
| violet/500 | COLOR | `#8b5cf6` |
| violet/600 | COLOR | `#7c3aed` |
| violet/700 | COLOR | `#6d28d9` |
| violet/800 | COLOR | `#5b21b6` |
| violet/900 | COLOR | `#4c1d95` |
| violet/950 | COLOR | `#2e1065` |
| purple/50 | COLOR | `#faf5ff` |
| purple/100 | COLOR | `#f3e8ff` |
| purple/200 | COLOR | `#e9d5ff` |
| purple/300 | COLOR | `#d8b4fe` |
| purple/400 | COLOR | `#c084fc` |
| purple/500 | COLOR | `#a855f7` |
| purple/600 | COLOR | `#9333ea` |
| purple/700 | COLOR | `#7e22ce` |
| purple/800 | COLOR | `#6b21a8` |
| purple/900 | COLOR | `#581c87` |
| purple/950 | COLOR | `#3b0764` |
| fuchsia/50 | COLOR | `#fdf4ff` |
| fuchsia/100 | COLOR | `#fae8ff` |
| fuchsia/200 | COLOR | `#f5d0fe` |
| fuchsia/300 | COLOR | `#f0abfc` |
| fuchsia/400 | COLOR | `#e879f9` |
| fuchsia/500 | COLOR | `#d946ef` |
| fuchsia/600 | COLOR | `#c026d3` |
| fuchsia/700 | COLOR | `#a21caf` |
| fuchsia/800 | COLOR | `#86198f` |
| fuchsia/900 | COLOR | `#701a75` |
| fuchsia/950 | COLOR | `#4a044e` |
| pink/50 | COLOR | `#fdf2f8` |
| pink/100 | COLOR | `#fce7f3` |
| pink/200 | COLOR | `#fbcfe8` |
| pink/300 | COLOR | `#f9a8d4` |
| pink/400 | COLOR | `#f472b6` |
| pink/500 | COLOR | `#ec4899` |
| pink/600 | COLOR | `#db2777` |
| pink/700 | COLOR | `#be185d` |
| pink/800 | COLOR | `#9d174d` |
| pink/900 | COLOR | `#831843` |
| pink/950 | COLOR | `#500724` |
| rose/50 | COLOR | `#fff1f2` |
| rose/100 | COLOR | `#ffe4e6` |
| rose/200 | COLOR | `#fecdd3` |
| rose/300 | COLOR | `#fda4af` |
| rose/400 | COLOR | `#fb7185` |
| rose/500 | COLOR | `#f43f5e` |
| rose/600 | COLOR | `#e11d48` |
| rose/700 | COLOR | `#be123c` |
| rose/800 | COLOR | `#9f1239` |
| rose/900 | COLOR | `#881337` |
| rose/950 | COLOR | `#4c0519` |
| white | COLOR | `#ffffff` |
| black | COLOR | `#000000` |

### Collection: shadcn/semantic  ·  32 variables  ·  modes: Light, Dark

| Variable | Type | Light | Dark |
|---|---|---|---|
| background | COLOR | → var:white | → var:zinc/950 |
| foreground | COLOR | → var:zinc/950 | → var:zinc/50 |
| card | COLOR | → var:white | → var:zinc/950 |
| card-foreground | COLOR | → var:zinc/950 | → var:zinc/50 |
| popover | COLOR | → var:white | → var:zinc/950 |
| popover-foreground | COLOR | → var:zinc/950 | → var:zinc/50 |
| primary | COLOR | → var:zinc/900 | → var:zinc/50 |
| primary-foreground | COLOR | → var:zinc/50 | → var:zinc/900 |
| secondary | COLOR | → var:zinc/100 | → var:zinc/800 |
| secondary-foreground | COLOR | → var:zinc/900 | → var:zinc/50 |
| muted | COLOR | → var:zinc/100 | → var:zinc/800 |
| muted-foreground | COLOR | → var:zinc/500 | → var:zinc/400 |
| accent | COLOR | → var:zinc/100 | → var:zinc/800 |
| accent-foreground | COLOR | → var:zinc/900 | → var:zinc/50 |
| destructive | COLOR | → var:red/500 | → var:red/900 |
| destructive-foreground | COLOR | → var:zinc/50 | → var:zinc/50 |
| border | COLOR | → var:zinc/200 | → var:zinc/800 |
| input | COLOR | → var:zinc/200 | → var:zinc/800 |
| ring | COLOR | → var:zinc/950 | → var:zinc/300 |
| chart-1 | COLOR | → var:orange/500 | → var:blue/500 |
| chart-2 | COLOR | → var:teal/500 | → var:emerald/500 |
| chart-3 | COLOR | → var:blue/500 | → var:amber/500 |
| chart-4 | COLOR | → var:amber/500 | → var:rose/500 |
| chart-5 | COLOR | → var:rose/500 | → var:violet/500 |
| sidebar-background | COLOR | → var:zinc/50 | → var:zinc/950 |
| sidebar-foreground | COLOR | → var:zinc/900 | → var:zinc/50 |
| sidebar-primary | COLOR | → var:zinc/900 | → var:zinc/50 |
| sidebar-primary-foreground | COLOR | → var:zinc/50 | → var:zinc/900 |
| sidebar-accent | COLOR | → var:zinc/100 | → var:zinc/800 |
| sidebar-accent-foreground | COLOR | → var:zinc/900 | → var:zinc/50 |
| sidebar-border | COLOR | → var:zinc/200 | → var:zinc/800 |
| sidebar-ring | COLOR | → var:zinc/950 | → var:zinc/300 |

## 5. Typography

### Fonts

- Inter

### Scale

| Token | Family | Size | Weight | Line height |
|---|---|---|---|---|
| h1 | Inter | 18px | 700 | auto |
| body-lg | Inter | 16px | 700 | auto |
| caption | Inter | 12px | 400 | auto |
| caption-2 | Inter | 12px | 500 | auto |

## 6. Spacing & Layout

### Base Unit

2px

### Border Radius

| Token | Value |
|---|---|
| radius-sm | 5px |
| radius-md | 6px |
| radius-lg | 12px |
| radius-lg-2 | 16px |

## 7. Depth & Motion

### Elevation

_no shadow effects found_

## 8. Components

### Button

Page: Page 1 · 15 variants

Reuse: import existing — key `34d47c1a1700b9c1179f4b2891138e5926191a19` · node `2:316`

| Property | Values |
|---|---|
| Variant | Default, Secondary, Outline, Ghost, Destructive |
| Size | Small, Medium, Large |

Sample variant structure:

- **Variant=Default, Size=Small** · `COMPONENT` · 63×27 · horizontal row, gap 6px, padding 6/12/6/12px · 1 children
  - **Button** · `TEXT` · 39×15 · “Button”

## 9. States

State tokens should be derived from the base palette above. Recommended mappings:

| State | Treatment |
|-------|-----------|
| Hover | Lighten/darken accent by 10% |
| Focus | 2px ring using accent color with 30% opacity |
| Disabled | 40% opacity, no pointer events |
| Error | Use danger color for border and text |

## 10. Rules

### Do

- Use the 2px base unit for all spacing decisions
- Use `#3b82f5` (accent) as the primary accent color
- Bind colors to the tokens below instead of hardcoding hex values

### Don't

- Introduce new colors without adding them to the palette
- Mix corner radii outside the radius scale

## 11. Extending this system

### How to reuse this DESIGN.md

Import into Figma with `figma-cli import <this file>` — colors, radii and typography become variables.

### When to add a new token vs reuse

Reuse the closest existing token; add a new one only when a new semantic role appears.

## 12. Machine-readable tokens

The block below is the canonical token map. It mirrors the tables above but is unambiguous and parseable.

```json design-tokens
{
  "$schema": "design-tokens.v1",
  "meta": {
    "source": "test-claude code",
    "generated": "2026-07-02"
  },
  "color": {
    "background": "#ffffff",
    "accent": "#3b82f5",
    "accent-alt": "#22c55e",
    "accent-3": "#8b5cf6",
    "surface": "#ede9fe",
    "text-primary": "#18181b",
    "background-alt": "#fafafa"
  },
  "typography": {
    "h1": {
      "fontFamily": "Inter",
      "fontSize": 18,
      "fontWeight": 700
    },
    "body-lg": {
      "fontFamily": "Inter",
      "fontSize": 16,
      "fontWeight": 700
    },
    "caption": {
      "fontFamily": "Inter",
      "fontSize": 12,
      "fontWeight": 400
    },
    "caption-2": {
      "fontFamily": "Inter",
      "fontSize": 12,
      "fontWeight": 500
    }
  },
  "spacing": {
    "base-unit": 2
  },
  "radius": {
    "radius-sm": "5px",
    "radius-md": "6px",
    "radius-lg": "12px",
    "radius-lg-2": "16px"
  },
  "shadow": {},
  "fonts": [
    "Inter"
  ],
  "variables": {
    "shadcn/primitives": {
      "modes": [
        "Mode 1"
      ],
      "variables": {
        "slate/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f8fafc"
          }
        },
        "slate/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f1f5f9"
          }
        },
        "slate/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e2e8f0"
          }
        },
        "slate/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#cbd5e1"
          }
        },
        "slate/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#94a3b8"
          }
        },
        "slate/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#64748b"
          }
        },
        "slate/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#475569"
          }
        },
        "slate/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#334155"
          }
        },
        "slate/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#1e293b"
          }
        },
        "slate/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0f172a"
          }
        },
        "slate/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#020617"
          }
        },
        "gray/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f9fafb"
          }
        },
        "gray/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f3f4f6"
          }
        },
        "gray/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e5e7eb"
          }
        },
        "gray/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#d1d5db"
          }
        },
        "gray/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#9ca3af"
          }
        },
        "gray/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#6b7280"
          }
        },
        "gray/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#4b5563"
          }
        },
        "gray/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#374151"
          }
        },
        "gray/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#1f2937"
          }
        },
        "gray/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#111827"
          }
        },
        "gray/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#030712"
          }
        },
        "zinc/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fafafa"
          }
        },
        "zinc/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f4f4f5"
          }
        },
        "zinc/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e4e4e7"
          }
        },
        "zinc/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#d4d4d8"
          }
        },
        "zinc/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a1a1aa"
          }
        },
        "zinc/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#71717a"
          }
        },
        "zinc/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#52525b"
          }
        },
        "zinc/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#3f3f46"
          }
        },
        "zinc/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#27272a"
          }
        },
        "zinc/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#18181b"
          }
        },
        "zinc/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#09090b"
          }
        },
        "neutral/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fafafa"
          }
        },
        "neutral/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f5f5f5"
          }
        },
        "neutral/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e5e5e5"
          }
        },
        "neutral/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#d4d4d4"
          }
        },
        "neutral/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a3a3a3"
          }
        },
        "neutral/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#737373"
          }
        },
        "neutral/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#525252"
          }
        },
        "neutral/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#404040"
          }
        },
        "neutral/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#262626"
          }
        },
        "neutral/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#171717"
          }
        },
        "neutral/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0a0a0a"
          }
        },
        "stone/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fafaf9"
          }
        },
        "stone/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f5f5f4"
          }
        },
        "stone/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e7e5e4"
          }
        },
        "stone/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#d6d3d1"
          }
        },
        "stone/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a8a29e"
          }
        },
        "stone/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#78716c"
          }
        },
        "stone/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#57534e"
          }
        },
        "stone/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#44403c"
          }
        },
        "stone/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#292524"
          }
        },
        "stone/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#1c1917"
          }
        },
        "stone/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0c0a09"
          }
        },
        "red/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fef2f2"
          }
        },
        "red/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fee2e2"
          }
        },
        "red/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fecaca"
          }
        },
        "red/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fca5a5"
          }
        },
        "red/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f87171"
          }
        },
        "red/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ef4444"
          }
        },
        "red/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#dc2626"
          }
        },
        "red/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#b91c1c"
          }
        },
        "red/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#991b1b"
          }
        },
        "red/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#7f1d1d"
          }
        },
        "red/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#450a0a"
          }
        },
        "orange/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fff7ed"
          }
        },
        "orange/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ffedd5"
          }
        },
        "orange/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fed7aa"
          }
        },
        "orange/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fdba74"
          }
        },
        "orange/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fb923c"
          }
        },
        "orange/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f97316"
          }
        },
        "orange/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ea580c"
          }
        },
        "orange/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#c2410c"
          }
        },
        "orange/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#9a3412"
          }
        },
        "orange/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#7c2d12"
          }
        },
        "orange/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#431407"
          }
        },
        "amber/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fffbeb"
          }
        },
        "amber/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fef3c7"
          }
        },
        "amber/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fde68a"
          }
        },
        "amber/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fcd34d"
          }
        },
        "amber/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fbbf24"
          }
        },
        "amber/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f59e0b"
          }
        },
        "amber/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#d97706"
          }
        },
        "amber/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#b45309"
          }
        },
        "amber/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#92400e"
          }
        },
        "amber/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#78350f"
          }
        },
        "amber/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#451a03"
          }
        },
        "yellow/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fefce8"
          }
        },
        "yellow/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fef9c3"
          }
        },
        "yellow/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fef08a"
          }
        },
        "yellow/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fde047"
          }
        },
        "yellow/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#facc15"
          }
        },
        "yellow/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#eab308"
          }
        },
        "yellow/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ca8a04"
          }
        },
        "yellow/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a16207"
          }
        },
        "yellow/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#854d0e"
          }
        },
        "yellow/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#713f12"
          }
        },
        "yellow/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#422006"
          }
        },
        "lime/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f7fee7"
          }
        },
        "lime/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ecfccb"
          }
        },
        "lime/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#d9f99d"
          }
        },
        "lime/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#bef264"
          }
        },
        "lime/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a3e635"
          }
        },
        "lime/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#84cc16"
          }
        },
        "lime/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#65a30d"
          }
        },
        "lime/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#4d7c0f"
          }
        },
        "lime/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#3f6212"
          }
        },
        "lime/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#365314"
          }
        },
        "lime/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#1a2e05"
          }
        },
        "green/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f0fdf4"
          }
        },
        "green/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#dcfce7"
          }
        },
        "green/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#bbf7d0"
          }
        },
        "green/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#86efac"
          }
        },
        "green/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#4ade80"
          }
        },
        "green/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#22c55e"
          }
        },
        "green/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#16a34a"
          }
        },
        "green/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#15803d"
          }
        },
        "green/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#166534"
          }
        },
        "green/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#14532d"
          }
        },
        "green/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#052e16"
          }
        },
        "emerald/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ecfdf5"
          }
        },
        "emerald/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#d1fae5"
          }
        },
        "emerald/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a7f3d0"
          }
        },
        "emerald/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#6ee7b7"
          }
        },
        "emerald/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#34d399"
          }
        },
        "emerald/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#10b981"
          }
        },
        "emerald/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#059669"
          }
        },
        "emerald/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#047857"
          }
        },
        "emerald/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#065f46"
          }
        },
        "emerald/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#064e3b"
          }
        },
        "emerald/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#022c22"
          }
        },
        "teal/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f0fdfa"
          }
        },
        "teal/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ccfbf1"
          }
        },
        "teal/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#99f6e4"
          }
        },
        "teal/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#5eead4"
          }
        },
        "teal/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#2dd4bf"
          }
        },
        "teal/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#14b8a6"
          }
        },
        "teal/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0d9488"
          }
        },
        "teal/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0f766e"
          }
        },
        "teal/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#115e59"
          }
        },
        "teal/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#134e4a"
          }
        },
        "teal/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#042f2e"
          }
        },
        "cyan/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ecfeff"
          }
        },
        "cyan/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#cffafe"
          }
        },
        "cyan/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a5f3fc"
          }
        },
        "cyan/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#67e8f9"
          }
        },
        "cyan/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#22d3ee"
          }
        },
        "cyan/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#06b6d4"
          }
        },
        "cyan/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0891b2"
          }
        },
        "cyan/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0e7490"
          }
        },
        "cyan/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#155e75"
          }
        },
        "cyan/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#164e63"
          }
        },
        "cyan/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#083344"
          }
        },
        "sky/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f0f9ff"
          }
        },
        "sky/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e0f2fe"
          }
        },
        "sky/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#bae6fd"
          }
        },
        "sky/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#7dd3fc"
          }
        },
        "sky/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#38bdf8"
          }
        },
        "sky/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0ea5e9"
          }
        },
        "sky/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0284c7"
          }
        },
        "sky/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0369a1"
          }
        },
        "sky/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#075985"
          }
        },
        "sky/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#0c4a6e"
          }
        },
        "sky/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#082f49"
          }
        },
        "blue/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#eff6ff"
          }
        },
        "blue/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#dbeafe"
          }
        },
        "blue/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#bfdbfe"
          }
        },
        "blue/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#93c5fd"
          }
        },
        "blue/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#60a5fa"
          }
        },
        "blue/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#3b82f6"
          }
        },
        "blue/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#2563eb"
          }
        },
        "blue/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#1d4ed8"
          }
        },
        "blue/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#1e40af"
          }
        },
        "blue/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#1e3a8a"
          }
        },
        "blue/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#172554"
          }
        },
        "indigo/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#eef2ff"
          }
        },
        "indigo/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e0e7ff"
          }
        },
        "indigo/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#c7d2fe"
          }
        },
        "indigo/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a5b4fc"
          }
        },
        "indigo/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#818cf8"
          }
        },
        "indigo/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#6366f1"
          }
        },
        "indigo/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#4f46e5"
          }
        },
        "indigo/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#4338ca"
          }
        },
        "indigo/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#3730a3"
          }
        },
        "indigo/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#312e81"
          }
        },
        "indigo/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#1e1b4b"
          }
        },
        "violet/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f5f3ff"
          }
        },
        "violet/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ede9fe"
          }
        },
        "violet/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ddd6fe"
          }
        },
        "violet/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#c4b5fd"
          }
        },
        "violet/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a78bfa"
          }
        },
        "violet/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#8b5cf6"
          }
        },
        "violet/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#7c3aed"
          }
        },
        "violet/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#6d28d9"
          }
        },
        "violet/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#5b21b6"
          }
        },
        "violet/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#4c1d95"
          }
        },
        "violet/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#2e1065"
          }
        },
        "purple/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#faf5ff"
          }
        },
        "purple/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f3e8ff"
          }
        },
        "purple/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e9d5ff"
          }
        },
        "purple/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#d8b4fe"
          }
        },
        "purple/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#c084fc"
          }
        },
        "purple/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a855f7"
          }
        },
        "purple/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#9333ea"
          }
        },
        "purple/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#7e22ce"
          }
        },
        "purple/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#6b21a8"
          }
        },
        "purple/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#581c87"
          }
        },
        "purple/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#3b0764"
          }
        },
        "fuchsia/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fdf4ff"
          }
        },
        "fuchsia/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fae8ff"
          }
        },
        "fuchsia/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f5d0fe"
          }
        },
        "fuchsia/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f0abfc"
          }
        },
        "fuchsia/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e879f9"
          }
        },
        "fuchsia/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#d946ef"
          }
        },
        "fuchsia/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#c026d3"
          }
        },
        "fuchsia/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#a21caf"
          }
        },
        "fuchsia/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#86198f"
          }
        },
        "fuchsia/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#701a75"
          }
        },
        "fuchsia/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#4a044e"
          }
        },
        "pink/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fdf2f8"
          }
        },
        "pink/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fce7f3"
          }
        },
        "pink/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fbcfe8"
          }
        },
        "pink/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f9a8d4"
          }
        },
        "pink/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f472b6"
          }
        },
        "pink/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ec4899"
          }
        },
        "pink/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#db2777"
          }
        },
        "pink/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#be185d"
          }
        },
        "pink/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#9d174d"
          }
        },
        "pink/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#831843"
          }
        },
        "pink/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#500724"
          }
        },
        "rose/50": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fff1f2"
          }
        },
        "rose/100": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ffe4e6"
          }
        },
        "rose/200": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fecdd3"
          }
        },
        "rose/300": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fda4af"
          }
        },
        "rose/400": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#fb7185"
          }
        },
        "rose/500": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#f43f5e"
          }
        },
        "rose/600": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#e11d48"
          }
        },
        "rose/700": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#be123c"
          }
        },
        "rose/800": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#9f1239"
          }
        },
        "rose/900": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#881337"
          }
        },
        "rose/950": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#4c0519"
          }
        },
        "white": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#ffffff"
          }
        },
        "black": {
          "type": "COLOR",
          "values": {
            "Mode 1": "#000000"
          }
        }
      }
    },
    "shadcn/semantic": {
      "modes": [
        "Light",
        "Dark"
      ],
      "variables": {
        "background": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "white"
            },
            "Dark": {
              "alias": "zinc/950"
            }
          }
        },
        "foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/950"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "card": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "white"
            },
            "Dark": {
              "alias": "zinc/950"
            }
          }
        },
        "card-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/950"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "popover": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "white"
            },
            "Dark": {
              "alias": "zinc/950"
            }
          }
        },
        "popover-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/950"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "primary": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/900"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "primary-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/50"
            },
            "Dark": {
              "alias": "zinc/900"
            }
          }
        },
        "secondary": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/100"
            },
            "Dark": {
              "alias": "zinc/800"
            }
          }
        },
        "secondary-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/900"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "muted": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/100"
            },
            "Dark": {
              "alias": "zinc/800"
            }
          }
        },
        "muted-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/500"
            },
            "Dark": {
              "alias": "zinc/400"
            }
          }
        },
        "accent": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/100"
            },
            "Dark": {
              "alias": "zinc/800"
            }
          }
        },
        "accent-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/900"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "destructive": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "red/500"
            },
            "Dark": {
              "alias": "red/900"
            }
          }
        },
        "destructive-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/50"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "border": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/200"
            },
            "Dark": {
              "alias": "zinc/800"
            }
          }
        },
        "input": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/200"
            },
            "Dark": {
              "alias": "zinc/800"
            }
          }
        },
        "ring": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/950"
            },
            "Dark": {
              "alias": "zinc/300"
            }
          }
        },
        "chart-1": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "orange/500"
            },
            "Dark": {
              "alias": "blue/500"
            }
          }
        },
        "chart-2": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "teal/500"
            },
            "Dark": {
              "alias": "emerald/500"
            }
          }
        },
        "chart-3": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "blue/500"
            },
            "Dark": {
              "alias": "amber/500"
            }
          }
        },
        "chart-4": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "amber/500"
            },
            "Dark": {
              "alias": "rose/500"
            }
          }
        },
        "chart-5": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "rose/500"
            },
            "Dark": {
              "alias": "violet/500"
            }
          }
        },
        "sidebar-background": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/50"
            },
            "Dark": {
              "alias": "zinc/950"
            }
          }
        },
        "sidebar-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/900"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "sidebar-primary": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/900"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "sidebar-primary-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/50"
            },
            "Dark": {
              "alias": "zinc/900"
            }
          }
        },
        "sidebar-accent": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/100"
            },
            "Dark": {
              "alias": "zinc/800"
            }
          }
        },
        "sidebar-accent-foreground": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/900"
            },
            "Dark": {
              "alias": "zinc/50"
            }
          }
        },
        "sidebar-border": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/200"
            },
            "Dark": {
              "alias": "zinc/800"
            }
          }
        },
        "sidebar-ring": {
          "type": "COLOR",
          "values": {
            "Light": {
              "alias": "zinc/950"
            },
            "Dark": {
              "alias": "zinc/300"
            }
          }
        }
      }
    }
  }
}
```
