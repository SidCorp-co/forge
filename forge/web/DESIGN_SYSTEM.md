# Forge Design System — "The Mono-Engineered Interface"

> Extracted from Stitch project `Forge - Linear Aesthetic` (ID: `3964809539190622327`)
> Design System: **Mono Engineered** — Creative North Star: **The Precision Instrument**

---

## 1. Overview & Creative North Star

This design system is not a template; it is a high-performance calibration tool. Inspired by the "Mono Engineered" aesthetic, the Creative North Star is **The Precision Instrument**.

Unlike standard dashboards that rely on heavy cards and shadows, this system treats the UI as a single, machined block of obsidian. We break the "web-page" feel through **extreme technical minimalism**: intentional asymmetry in data density, high-contrast typography scales, and a rejection of traditional decorative elements. Every pixel must feel like it was placed by a mathematical formula, emphasizing speed, clarity, and technical authority.

---

## 2. Color Palette — Full Token Reference

### Surface Hierarchy (Depth Layers)

| Token | Hex | Usage |
|---|---|---|
| `surface-container-lowest` | `#0d0e0f` | True background / void / deepest layer |
| `surface` / `surface-dim` | `#121314` | Base app surface / sidebar bg |
| `surface-container-low` | `#1b1c1d` | Primary containers / cards / main body |
| `surface-container` | `#1f2021` | Active workspace staging area |
| `surface-container-high` | `#292a2b` | Elevated components / modals |
| `surface-container-highest` | `#343536` | Hover states / highest emphasis |
| `surface-variant` | `#343536` | Chip backgrounds / secondary fills |
| `surface-bright` | `#39393a` | Bright accent surfaces |

### Text & Content Colors

| Token | Hex | Usage |
|---|---|---|
| `on-surface` / `on-background` | `#e3e2e3` | Primary text |
| `on-surface-variant` | `#c6c6c6` | Secondary text / labels / metadata |
| `primary` / `on-primary-fixed` | `#ffffff` | High emphasis / headings / buttons |
| `on-primary` | `#1a1c1c` | Text on white/primary buttons |
| `secondary` | `#c8c6c6` | Muted body text |
| `secondary-fixed-dim` | `#acabab` | De-emphasized text |
| `surface-tint` | `#c6c6c7` | Subtle tinting |

### Border & Outline Colors

| Token | Hex | Usage |
|---|---|---|
| `outline` | `#919191` | Active input borders / focus states |
| `outline-variant` | `#474747` | Ghost borders (use at 20-30% opacity) |
| `secondary-container` | `#474747` | Secondary button bg / containers |

### Functional Colors

| Token | Hex | Usage |
|---|---|---|
| `error` | `#ffb4ab` | Error text (desaturated) |
| `error-container` | `#93000a` | Error backgrounds |
| `on-error` | `#690005` | Text on error containers |
| `on-error-container` | `#ffdad6` | Error text on dark error bg |
| `tertiary` | `#e2e2e2` | Tertiary emphasis / gradient end |
| `tertiary-container` | `#919191` | Tertiary containers |
| `primary-container` | `#d4d4d4` | Primary container fills |
| `primary-fixed` | `#5d5f5f` | Fixed primary variant |
| `primary-fixed-dim` | `#454747` | Dimmed primary |

### Tailwind Config (from Stitch)

```js
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "surface-container": "#1f2021",
        "secondary": "#c8c6c6",
        "on-surface-variant": "#c6c6c6",
        "surface-bright": "#39393a",
        "on-tertiary-container": "#000000",
        "inverse-surface": "#e3e2e3",
        "tertiary-fixed": "#5e5e5e",
        "on-primary-fixed-variant": "#e2e2e2",
        "on-primary": "#1a1c1c",
        "surface-container-high": "#292a2b",
        "on-secondary-container": "#e4e2e2",
        "surface-container-highest": "#343536",
        "tertiary": "#e2e2e2",
        "on-tertiary-fixed-variant": "#e2e2e2",
        "background": "#0d0e0f",
        "surface-container-lowest": "#0d0e0f",
        "error": "#ffb4ab",
        "secondary-fixed-dim": "#acabab",
        "surface-tint": "#c6c6c7",
        "surface": "#121314",
        "outline": "#919191",
        "on-primary-fixed": "#ffffff",
        "on-error-container": "#ffdad6",
        "tertiary-fixed-dim": "#474747",
        "primary-fixed": "#5d5f5f",
        "primary": "#ffffff",
        "surface-variant": "#343536",
        "error-container": "#93000a",
        "on-secondary": "#1b1c1c",
        "surface-dim": "#121314",
        "on-surface": "#e3e2e3",
        "on-background": "#e3e2e3",
        "surface-container-low": "#1b1c1d",
        "on-secondary-fixed": "#1b1c1c",
        "inverse-primary": "#5d5f5f",
        "on-tertiary-fixed": "#ffffff",
        "secondary-container": "#474747",
        "outline-variant": "#474747",
        "on-secondary-fixed-variant": "#3b3b3b",
        "on-error": "#690005",
        "on-primary-container": "#000000",
        "inverse-on-surface": "#303031",
        "tertiary-container": "#919191",
        "primary-fixed-dim": "#454747",
        "on-tertiary": "#1b1b1b",
        "primary-container": "#d4d4d4",
        "secondary-fixed": "#c8c6c6"
      },
      fontFamily: {
        "headline": ["Inter"],
        "body": ["Inter"],
        "label": ["Inter"]
      },
      borderRadius: {
        "DEFAULT": "0.125rem",
        "lg": "0.25rem",
        "xl": "0.5rem",
        "full": "0.75rem"
      },
    },
  },
}
```

### Custom CSS Classes (from Stitch)

```css
body {
  background-color: #0d0e0f;
  color: #e3e2e3;
  font-family: "Inter", sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Bottom-border-only inputs (command-line style) */
.mono-input {
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(145, 145, 145, 0.3);
  border-radius: 0;
  transition: border-color 0.2s ease;
}
.mono-input:focus {
  outline: none;
  border-bottom-color: #fff;
}

/* Primary action button gradient */
.btn-gradient {
  background: linear-gradient(135deg, #fff 0%, #e2e2e2 100%);
}

/* Noise texture overlay */
.noise-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.02;
  z-index: 9999;
}
```

---

## 3. Colors & Surface Logic

### The "No-Line" Rule
Standard 1px solid borders are restricted to the global container frame or specific data-grid dividers only when necessary. To section the dashboard, use **background shifts**. A sidebar should be `surface` (#121314) sitting against the main body of `surface-container-low` (#1b1c1d).

### Surface Hierarchy & Nesting
Use **"Inverted Nesting."** To draw focus to a specific module, do not lift it with a shadow; instead, sink the surrounding area. Place `surface-container-high` (#292a2b) elements inside a `surface-dim` (#121314) wrapper to create a sense of mechanical assembly.

### The "Glass & Gradient" Rule
For floating command menus or modals, use `surface-bright` (#39393a) at 80% opacity with a `backdrop-blur` of 20px. This creates a "monolith" effect where the underlying data is still felt but suppressed.

### Signature Textures
Apply a subtle linear gradient to the `primary` (#ffffff) action buttons, transitioning from `#ffffff` to `tertiary` (#e2e2e2) at a 135-degree angle. This prevents the white from "blooming" too harshly on the dark background and adds a tactile, satin-finish feel.

---

## 4. Typography: The Editorial Engineer

Font: **Inter** exclusively.

| Scale | Size | Usage |
|---|---|---|
| `display-lg` | 3.5rem | Singular high-impact data points |
| `headline-sm` | 1.5rem | Module titles (Semibold) |
| `body-md` | 0.875rem | Standard data / body text (Regular) |
| `label-sm` | 0.6875rem | Timestamps, tags, metadata |
| `text-[10px]` | 0.625rem | Uppercase tracked labels |
| `text-[9px]` | 0.5625rem | Footer metadata / micro labels |

### Rules
- **Power Scale:** Big numbers → tiny labels. The "Big-Small" juxtaposition is the hallmark.
- **Monospace Utility:** Numerical data uses tabular lining (`font-variant-numeric: tabular-nums`).
- **Hierarchy via Weight:** Semibold for titles, Regular for body. Never bold body text.
- **Tracking:** Labels use `tracking-widest` or `tracking-[0.2em]` in `uppercase`.

---

## 5. Elevation & Depth: Tonal Layering

No traditional drop shadows. Depth is achieved through **hardware-inspired stacking**:

| Level | Token | Hex | Usage |
|---|---|---|---|
| 0 (Base) | `surface-container-lowest` | `#0d0e0f` | Page background |
| 1 (Modules) | `surface-container-low` | `#1b1c1d` | Cards, containers |
| 2 (Active) | `surface-container-highest` | `#343536` | Hover, active states |

- **Ambient Shadows:** `box-shadow: 0 10px 30px rgba(13,14,15,0.5)` — barely visible.
- **Ghost Border:** `outline-variant` (#474747) at 20-30% opacity. Felt, not seen.

---

## 6. Components: Machined Primitives

### Buttons
- **Primary:** `bg-white text-[#1a1c1c]` with `rounded-sm` (0.125rem). Use `btn-gradient` for premium feel.
- **Secondary:** `bg-[#474747] text-white` with no border.
- **Ghost:** No border, `text-[#c6c6c6]`, white on hover.

### Input Fields
- Bottom-only border: `border-b border-[#919191]/30`
- No rounded corners (`rounded-none`)
- Focus: `border-b-white`
- Label: `text-[10px] uppercase tracking-widest text-[#c6c6c6]`

### Cards & Lists
- **No divider lines** between items. Use `gap-2` (0.5rem) spacing.
- Group headers: `text-[10px] uppercase tracking-widest text-[#5d5f5f]`
- Hover: `bg-[#343536]/10` with instant 50ms transition.

### Chips/Badges
- `bg-[#343536] text-[#c6c6c6] rounded` (0.25rem, not full pill).

### Status Terminal (Custom)
- `bg-[#0d0e0f] border border-[#474747]/40`
- `text-[9px] font-mono text-[#919191]/60`

---

## 7. Do's and Don'ts

### ✅ Do
- **Embrace Negative Space** — Use 3.5rem+ spacing to isolate critical data
- **Use Asymmetry** — Large headline left, dense metadata right
- **Maintain Sharpness** — `rounded-sm` (2px) or `rounded-none` only
- **Monochromatic Icons** — 16×16px, same color as adjacent text

### ❌ Don't
- **No Pure Black** — Use `#0d0e0f`, never `#000000`
- **No Soft Corners** — No `rounded-xl` or `rounded-full` on functional components
- **No Traditional Dividers** — No `<hr>` or border-bottom between list items
- **No Saturated Colors** — Even errors use `#ffb4ab` (desaturated)
- **No Bouncy Animations** — linear or ease-out, <200ms duration
