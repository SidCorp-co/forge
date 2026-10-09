# web-v2

The Forge cloud UI — canonical at root `/` since ISS-397 (2026-06-07; legacy
`packages/web` retired).

- **Brand:** light-first "calm, bright workshop" — warm paper neutrals, flame-orange
  action accent, cobalt structure, one hue per staged job type. Hanken Grotesk +
  JetBrains Mono.
- **Stack:** Next.js 16 (App Router) · React 19 · Tailwind v4 (CSS `@theme`, no config
  file) · custom primitives (no shadcn) · lucide-react · TanStack Query. Consumes the
  `core` REST/WS contract via `@forge/contracts`.

## Tokens — 2 layers (light-only now, dark drop-in)

`src/styles/tokens.css` is the source of truth.

1. **Raw palette** — `--flame-*`, `--paper-*`, `--ink-*`, `--stage-*`. Theme-independent.
   Components never reference these directly, never hardcode hex.
2. **Semantic** — `--bg-*`, `--fg-*`, `--border-*`, `--accent`, … Components reference
   **only** this layer. `globals.css` maps it into Tailwind via `@theme inline` so
   utilities resolve through the semantic var.

Adding dark later = one `[data-theme="dark"] { … }` override of the semantic block
(`tokens.css` already declares one for the workflow canvas hues, the AI marks and
`--fg-danger`) + flip `forcedTheme` in `providers/theme-provider.tsx`. Raw scale +
every component stay untouched.

> Exception: data-driven color (status / health / stage dots) lives in
> `src/design/status.ts` + `stages.ts` and references the raw palette on purpose —
> the color *is* the datum.

## Layout

```
src/
├─ styles/tokens.css        # source of truth (raw + semantic tokens)
├─ app/
│  ├─ globals.css           # @import tokens + @theme inline + base + keyframes
│  └─ layout.tsx            # fonts (next/font) + providers
├─ design/                  # presentational, data-agnostic
│  ├─ icons/icon.tsx        # semantic name → lucide-react
│  ├─ stages.ts · status.ts # job-type hues + status/health/avatar meta
│  ├─ primitives/           # Button, StatusChip, MonoTag, Avatar, ProjectMark,
│  │                        #   HealthDot, Stat, PageSection, Kicker, Spinner, EmptyState,
│  │                        #   Input, Field, Toggle, SegmentedControl
│  ├─ patterns/             # KanbanCard, KanbanColumn, NavRail, BottomTabBar,
│  │                        #   CommandPalette, NotificationsMenu
│  └─ index.ts              # barrel — import from "@/design"
├─ features/                # ← every screen lives here, one module per domain
│                          #   (api.ts + types.ts + components/ + hooks/);
│                          #   `ls -d src/features/*/` is the inventory
├─ lib/utils/cn.ts
└─ providers/               # theme, query
```

The `primitives/` and `patterns/` lists above are illustrative, not exhaustive —
`ls src/design/primitives src/design/patterns` is the current set.

## Run

```bash
pnpm --filter web-v2 dev      # http://localhost:3100  → Overview dashboard
```

`/` renders the Overview dashboard.

## Screen witness

jsdom lays nothing out, so the vitest suite cannot see a defect only a window width shows.
`witness/run.mjs` mounts a real component with the app's compiled CSS in headless Chrome at
each width its entry names and fails on every probe the entry reports:

```bash
pnpm --filter web-v2 witness witness/check-times.witness.tsx --out <dir>   # screenshots land in <dir>
```

An entry (`witness/*.witness.tsx`) stubs core's reads, mounts the component and sets
`window.__witness` — its cases, when it is ready, and its probe. Chrome is `WITNESS_CHROME`,
else `google-chrome`. No CI job runs it: a screen change that can break at a width runs it and
attaches what it printed.
