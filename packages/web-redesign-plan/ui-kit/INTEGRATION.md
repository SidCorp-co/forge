# Forge Web — Integration & Structure Guide

How to take this design system from prototype → production inside
`packages/web`. This proposes a **standard structure** and the conventions I'll
follow when you link the real code.

**Default stack chosen** (modern Next.js control-plane defaults — I'll confirm
and adapt the moment you link the real repo):

| Concern | Default | Why |
|---|---|---|
| Styling | **Tailwind CSS, mapped to the CSS-variable tokens** | Utilities stay on-brand; `tokens.css` remains the single source of truth. |
| Primitives | **shadcn/ui** (Radix under the hood) | De-facto for Next.js; unstyled + accessible, easy to skin with our tokens. |
| Icons | **lucide-react** | Matches the Lucide-style set already used in the kit. |
| Data/state | **TanStack Query** + a WebSocket provider that invalidates queries | Fits the real-time, multi-device model. |
| Types | **`@forge/contracts`** imported everywhere | One REST contract across clients. |
| Structure | **Proposed below**, conforming to the existing `features/` pattern | Mix: adopt where the repo is silent, match where it's opinionated. |

Anything marked **[verify]** is inferred from the REST API map
(`packages/web/src/features/**`, `apiClient`, `contracts`) — I'll confirm against
the real tree.

---

## 1. Where things live (proposed `packages/web/src`)

```
packages/web/src/
├─ app/                        # Next.js routes — thin; compose feature screens
│   └─ (dashboard)/
│       ├─ layout.tsx          # NavRail + TopBar shell
│       ├─ board/page.tsx
│       ├─ pipeline/page.tsx
│       ├─ sessions/page.tsx
│       ├─ sessions/[id]/page.tsx
│       ├─ runners/page.tsx
│       └─ …
├─ styles/
│   ├─ tokens.css             # ← colors_and_type.css (design tokens; source of truth)
│   └─ globals.css            # reset + @import tokens + base element styles
├─ design/                    # the design layer (this kit, productionized)
│   ├─ icons/Icon.tsx         # icon component (or re-export lucide-react)
│   ├─ primitives/            # Button, StatusChip, MonoTag, Avatar, Stat, Toggle, Field
│   ├─ patterns/              # PipelineTracker, KanbanCard, CommandPalette, NotificationsMenu
│   └─ index.ts               # barrel export
├─ features/                  # existing feature-folder pattern  [verify]
│   └─ <domain>/              # e.g. agent-sessions, issues, runners, pipeline, skills
│       ├─ api/               # apiClient calls — 1:1 with core routes
│       ├─ components/        # screens, composed from design/ primitives
│       ├─ hooks/             # data hooks (useSessions, useQueueStats, …)
│       └─ types.ts           # or import from @forge/contracts
├─ lib/                       # apiClient, ws client, query setup
└─ providers/                 # theme, query, websocket providers
```

**Principle:** `design/` knows nothing about data; `features/` wires data into
design components; `app/` just composes. Tokens live once in `styles/tokens.css`.

---

## 2. Prototype file → production location

| Prototype (`ui_kits/web/`) | Production target | Notes |
|---|---|---|
| `colors_and_type.css` | `styles/tokens.css` | Drop in as-is. Source of truth. |
| `Icon.jsx` | `design/icons/Icon.tsx` | Or replace with `lucide-react` (confirm icon set). |
| `Primitives.jsx` | `design/primitives/*` | One file per component, typed props. |
| `PipelineTracker.jsx` | `design/patterns/PipelineTracker.tsx` | Pure, takes `stage`/`status`. |
| `Shell.jsx` | `app/(dashboard)/layout.tsx` + `design/patterns/NavRail,TopBar` | |
| `BoardScreen.jsx` | `features/issues/components/BoardScreen.tsx` | |
| `PipelineScreen.jsx` | `features/pipeline/components/PipelineBoard.tsx` | |
| `SessionsListScreen.jsx` | `features/agent-sessions/components/SessionsList.tsx` | + `useQueueStats`, `useSessions` |
| `SessionScreen.jsx` | `features/agent-sessions/components/SessionThread.tsx` | turns from `GET /:id/turns` |
| `RunDetail.jsx` | `features/issues/components/RunDetailPanel.tsx` | |
| `RunnersScreen.jsx` | `features/runners/components/RunnersGrid.tsx` | |
| `ListScreens.jsx` | split into `features/{activity,skills,schedules}/components/` | |
| `Overlays.jsx` | `design/patterns/{CommandPalette,NotificationsMenu}.tsx` | |
| `Data.jsx` | **delete** | Replaced by `@forge/contracts` types + API hooks. |

---

## 3. Tokens in code

The tokens are framework-agnostic CSS variables in `tokens.css` (the source of
truth). **Default: Tailwind mapped to the vars** so utilities never hard-code
hex:
```ts
// tailwind.config.ts
theme: { extend: {
  colors: { flame: 'var(--flame-500)', cobalt: 'var(--cobalt-500)',
            ink: 'var(--ink-900)', paper: 'var(--paper-50)' },
  borderRadius: { md: 'var(--r-md)', lg: 'var(--r-lg)' },
  fontFamily: { sans: 'var(--font-sans)', mono: 'var(--font-mono)' },
}}
```
For CSS Modules / plain CSS instead, reference the vars directly
(`background: var(--accent)`). **Either way: never introduce new hex values —
extend `tokens.css`.**

---

## 4. Conventions (carry over from the design system README)

- **TypeScript everywhere**; shared shapes import from `@forge/contracts`, never
  redefined per client.
- **Data layer:** one `api/` function per core route, wrapped in a TanStack Query
  hook; co-locate with the feature that owns it (mirrors how the API map groups
  callers). Real-time updates come from the WebSocket provider invalidating the
  relevant queries, not polling.
- **Copy:** sentence case; monospace for IDs / stages / metrics / endpoints;
  the status vocabulary (`queued · running · blocked · waiting · passed ·
  failed · paused · done`) is fixed — reuse the exact words.
- **Flame** = action + active stage only. **No new colors, no emoji.**
- **Components** are presentational + typed; side effects live in hooks.

---

## 5. To finalize against your repo

The defaults above let me start now. When you link the repo (or just
`packages/web` + `packages/contracts`) via the Import menu, I'll:

1. Replace every **[verify]** with the actual pattern, and swap any default that
   doesn't match what you really use (styling, primitives, icons, data layer).
2. Read your path aliases, lint/format rules, and how `contracts` is consumed.
3. Start emitting production components that compile in your repo, feature by
   feature — beginning with the design `primitives/` and the agent-sessions
   feature (the richest surface).

Until then, treat this file as the contract for how the prototype maps to
production.
