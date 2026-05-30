# web-v2

The redesigned Forge cloud UI — built in parallel with `packages/web`, switchable
on the UI, big-bang cutover when the core loop is covered. See
[`docs/proposals/web-v2-redesign.md`](../../docs/proposals/web-v2-redesign.md).

- **Brand:** light-first "calm, bright workshop" — warm paper neutrals, flame-orange
  action accent, cobalt structure, the 7-stage pipeline hue motif. Hanken Grotesk +
  JetBrains Mono.
- **Stack:** Next.js 16 (App Router) · React 19 · Tailwind v4 (CSS `@theme`, no config
  file) · custom primitives (no shadcn) · lucide-react · TanStack Query. Shares the
  same `core` REST/WS contract + `@forge/contracts` as `packages/web`.

## Tokens — 2 layers (light-only now, dark drop-in)

`src/styles/tokens.css` is the source of truth (mirrors the design-system kit).

1. **Raw palette** — `--flame-*`, `--paper-*`, `--ink-*`, `--stage-*`. Theme-independent.
   Components never reference these directly, never hardcode hex.
2. **Semantic** — `--bg-*`, `--fg-*`, `--border-*`, `--accent`, … Components reference
   **only** this layer. `globals.css` maps it into Tailwind via `@theme inline` so
   utilities resolve through the semantic var.

Adding dark later = one `[data-theme="dark"] { … }` override of the semantic block
(the selector already exists, commented, in `tokens.css`) + flip `forcedTheme` in
`providers/theme-provider.tsx`. Raw scale + every component stay untouched.

> Exception: data-driven color (status / health / stage dots) lives in
> `src/design/status.ts` + `stages.ts` and references the raw palette on purpose —
> the color *is* the datum.

## Layout

```
src/
├─ styles/tokens.css        # source of truth (raw + semantic tokens)
├─ app/
│  ├─ globals.css           # @import tokens + @theme inline + base + keyframes
│  ├─ layout.tsx            # fonts (next/font) + providers
│  └─ kit/page.tsx          # ← component gallery (preview everything)
├─ design/                  # presentational, data-agnostic
│  ├─ icons/icon.tsx        # semantic name → lucide-react
│  ├─ stages.ts · status.ts # stage + status/health/avatar meta
│  ├─ primitives/           # Button, StatusChip, MonoTag, Avatar, ProjectMark,
│  │                        #   HealthDot, Stat, Card, Kicker, Spinner, EmptyState,
│  │                        #   Input, Field, Toggle, SegmentedControl
│  ├─ patterns/             # PipelineTracker, KanbanCard, NavRail, TopBar,
│  │                        #   CommandPalette, NotificationsMenu
│  └─ index.ts              # barrel — import from "@/design"
├─ lib/utils/cn.ts
└─ providers/               # theme, query
```

## Run

```bash
pnpm --filter web-v2 dev      # http://localhost:3100  → redirects to /kit
```

Open **`/kit`** to preview every primitive and pattern.
