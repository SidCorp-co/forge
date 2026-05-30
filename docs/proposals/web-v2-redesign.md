# Proposal: Web v2 — full redesign (parallel package)

- **Status:** Draft proposal (pre-RFC)
- **Date:** 2026-05-30
- **Design reference:** `packages/web-redesign-plan/` (design-system tokens + hi-fi ui-kit prototype + INTEGRATION.md)
- **Approach:** new `packages/web-v2` built in parallel, UI-switchable, **big-bang cutover** when core loop is covered. Backend (`core` REST/WS) + `@forge/contracts` unchanged.

## Why

The redesign kit defines a new brand — *"calm, bright workshop"*: light-first, warm paper neutrals, flame-orange action accent, cobalt structure, the 7-stage pipeline hue motif, Hanken Grotesk + JetBrains Mono. Current `packages/web` is dark-first monochrome (MD3 "Stitch"), and has accumulated **orphan + double-meaning routes**. v2 is a clean reskin + IA cleanup, not a feature add.

## Decisions (locked)

| # | Decision |
|---|----------|
| A | **Parallel `packages/web-v2`**, switchable on UI, big-bang release. Shared backend. |
| B | New **standard token + folder structure**; no aliasing onto old `--color-*`. |
| C | **Light-only** now, but tokens defined in **2 layers** so dark is a drop-in. |
| D | **Two-tier nav (kit)** + keep URL nesting `/projects/[slug]/*`. |
| E | **Keep custom primitives** (extend `design/primitives`); no shadcn/Radix. |
| 1 | Issue views: lean to the design → **Board (list) + Pipeline (stage-kanban) only**; drop the separate status-kanban. |
| 2 | **Defer entirely:** admin/*, ceo, ceo/dashboard, usage, settings/sessions. |
| 3 | Switch: **separate Coolify app + cookie toggle** ("Try new UI" ⇄ "Back to classic"). |

## Scope cleanup (from current web)

**Drop / defer (orphan or dead — verified via nav + grep):**
`/ceo` (UnimplementedBanner), `/ceo/dashboard` (experimental, defer), `/admin/*` (no nav links, defer to admin bundle), `/usage` (orphan → fold into pipeline analytics later), `/settings/sessions` ("Coming soon"), `/devices` (only 302s to `/settings/devices`).

**Consolidate (double meaning):**
- **Devices ×3** (`/devices`, `/settings/devices`, `/admin/devices`) → one **Runners** surface (my devices + per-project runners + quota); global admin view → admin bundle.
- **"Sessions" overloaded** (agent-runs vs auth-login) → agent runs = **Sessions**; auth = **Sign-in activity** (later).
- **`/dashboard` + `/projects`** → one **Projects console** (needs-attention banner + pinned, per kit).

**Keep — genuinely distinct:** Issues (table) vs Pipeline (kanban); Knowledge (user sources) vs Memory (system breadcrumbs, grouped under **Context**); Chat (`/agent`) vs Agents/Sessions.

Result: ~40 routes → **~18 core surfaces** + 1 deferred admin bundle.

## IA (web-v2)

- **Workspace tier:** Projects console · Activity · Runners · Sessions (cross-project queue + sweep) · Pipeline ops.
- **Project tier** (`/projects/[slug]/*`): Overview · Issues (table) · Pipeline (stage-kanban, hero) · Board (issue list) · Sessions (project-scoped) · Chat · Skills · Schedules · Context (Knowledge + Memory) · PM · Settings.
- **Pipeline ops** — kept in v2 core (daily-ops view, not admin); the 4 current routes (`/pipeline`, `/progress`, `/health`, `/runs`) collapse into **one tabbed surface**.
- **Sessions** — **both tiers, one shared component, different filter**: workspace-level for the total queue + sweep-zombies, project-scoped for runs in context.
- **Account/global:** Account · Tokens · MCP · Notifications · Chat-logs.

## Structure (standardized day-one)

```
packages/web-v2/src/
├─ app/ (auth)/ (workspace)/[…/projects/[slug]/…] settings/ (admin: deferred)
├─ styles/  tokens.css (= colors_and_type.css, source of truth) + globals.css (@theme inline)
├─ design/  icons/ primitives/ patterns/ index.ts   # presentational, data-agnostic
├─ features/<domain>/  api/ hooks/ components/ types.ts
├─ lib/      apiClient · ws · query (ported from web)
└─ providers/ theme · query · ws
```

Rule: `design/` never touches data → `features/` wires data → `app/` composes.

## Tokens — 2 layers (light-only now, dark drop-in)

- **Layer 1 — raw palette** (theme-independent): `--flame-*`, `--paper-*`, `--ink-*`, `--cobalt-*`, `--stage-*`. Components never reference these, never hardcode hex.
- **Layer 2 — semantic**: `--bg-app/-surface`, `--fg-default/-muted`, `--accent`, `--border-*`, `--focus-ring`, `--stage-active`. **Components reference only this layer.**
- Tailwind v4 `@theme inline` maps utilities → semantic vars (no `tailwind.config.ts`).
- Adding dark later = one `[data-theme="dark"] { … }` override of the semantic layer; raw scale + components untouched. Enforced by review rule: *no hex / no raw-scale in `features/` & `app/`*.

## Switch + cutover (A)

`web-v2` is its own Next.js app sharing `@forge/contracts` + `core` REST/WS (no DB/contract change). Deploy as a separate Coolify app; current web TopBar gets *"Try new UI"* (cookie + redirect), v2 has *"Back to classic"*. Big-bang: flip default, retire `packages/web` (clean-break, v0.1 — no long-lived shim).

## Phased build

0. **Foundation** — scaffold web-v2, port `lib/` + providers, 2-layer tokens, Hanken/JetBrains via `next/font`, NavRail (2-tier) + TopBar.
1. **Design layer** — primitives + patterns (PipelineTracker hero, CommandPalette, NotificationsMenu), typed.
2. **Sessions** — richest surface first; SessionsList + SessionThread wired live.
3. **Core loop** — Issues table + Issue detail (simple + rich/ISS-273) + Pipeline kanban + RunDetail.
4. **Workspace** — Projects console (merges dashboard) + Runners (merges 3 device UIs) + Activity + Skills + Schedules + Context + PM + Login.
5. **Switch + dark-ready audit** — cookie toggle; verify semantic-only token usage.
6. **Verify** — Playwright walk core loop; compare against `Forge - Web App.html`.

## Design gaps to fill (kit doesn't cover these)

The kit designs the core loop + brand. Still **needs design/reskin with no mockup**:
- Settings sub-pages (Account, Tokens, MCP, Notifications), PM Agent, Knowledge, Memory, project Overview, Schedules detail, single-Chat (`/agent`).
- Auth/onboarding beyond Login: register, connect-device, download, landing.
- **Responsive/mobile** — kit is fixed 1180px desktop only.
- **Per-screen loading / error / empty states** at scale (real lists use virtualization/pagination).
- **Dark theme** values (deferred, but reserve the semantic block).
