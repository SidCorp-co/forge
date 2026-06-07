# Proposal: Web v2 — v1 retirement parity matrix

Companion to [web-v2-redesign.md](web-v2-redesign.md). The decided port-or-drop matrix for every legacy `packages/web` (v1) surface, so v1 can be retired without losing a live surface. This is the durable record of the ISS-394 parity audit; the actual porting/deletion is owned by the ISS-395 v1-retirement track.

- **Status:** Decided (matrix), pending product sign-off on the two flagged calls (C2, C3)
- **Verified against:** `packages/web-v2` HEAD `f53853fd` (route trees + feature modules)
- **Out of scope:** Coolify + Epodsystem integration config (owned by the ISS-395 integrations-port track); `packages/web` deletion + cutover routing (ISS-395 Part 2)

## Background

v1 = `packages/web` (owns the host, proxies `/v2`). v2 = `packages/web-v2` (Next app served at `/v2`, live on forge-beta). The strangler list `packages/web/src/middleware.ts` `V2_MIGRATED_PATHS` currently maps only `/dashboard → /v2`. Retiring v1 requires every remaining v1 surface to be **at parity in v2, ported, or explicitly dropped**. web-v2 consumes existing **core REST via `apiClient`** (no MCP), so the ports below are frontend-only mirrors against endpoints that already exist.

## A. Already at parity in v2 — no action

| v1 surface | v2 equivalent | evidence |
|---|---|---|
| `/projects/[slug]/knowledge` `/memory` `/skills` | `/library` (Knowledge/Memory/Skills tabs) | `features/library` merged shell (ISS-307) |
| `/projects/[slug]/schedules` + `/pm` | `/automation` ("merged Schedules + PM") | `automation/page.tsx` |
| `/(protected)/pipeline` health/progress/runs | `/ops` (Monitor/Progress/Health/Runs) | `ops/page.tsx` (ISS-295) |
| `/(protected)/chat-logs` | `/sessions` | `sessions/page.tsx` cross-project index |
| `/connect-device` | `/pair` | `features/pairing` (ISS-305) |
| `/projects/[slug]/issues` | `/issues` + `/issues/[id]` | parity |
| settings → Archive/Unarchive | settings → **Advanced** tab | `advanced-tab.tsx` (ISS-353) |
| settings → Skill Registrations | `/library` Skills tab | `skills-screen.tsx` wires `useRegisterSkill`/`useUnregisterSkill` (`onRegister(skillId, stage)` / `onUnregister(stage)`) — full per-stage binding UI |

## B. Drop — delete with v1

| v1 surface | rationale |
|---|---|
| `/projects/[slug]/agent` (legacy chat) | Duplicate of `/agents` (+ `/agents/[sessionId]`), already at parity in v2. |
| `/(landing)/*` (public marketing) | Marketing surface, outside the authenticated product. |
| `/download` (desktop download links) | Static links; relocate to an external/static page if still needed. |
| `/forge-config` (legacy) | Superseded by per-project + workspace settings. |
| `/board` per-column **WIP-limit** (`boardCfg.wipLimits` via `setWipLimit`) | Core issue-kanban (issues grouped by stage + drag-to-restage) is covered by v2 `/pipeline` (`pipeline-board.tsx`, ISS-295). Only the per-column WIP-limit config has no v2 equivalent; low usage. File a small v2-pipeline enhancement if wanted later — do not block retirement on it. |

## C. Port — needs follow-on work before v1 deletion

**C1 — Project-settings config sections** *(tracked by ISS-396).* v2 project-settings has 8 tabs (Basics/Repository/Testing/Pipeline/Labels/Members/Integrations/Advanced); the Integrations tab is a stub deferring to the workspace `/integrations` route (today Coolify/Sentry/Postman only). Missing config-edit surfaces, each in v1 `packages/web/src/app/projects/[slug]/settings/components/`:

| v1 section | file |
|---|---|
| Chat Agent (`agent.chat`) | `chat-agent-section.tsx` |
| Providers/Tools (MCP + model config, `agent.providers`) | `providers-tools-section.tsx` |
| Device Integration | `device-integration-section.tsx` |
| GitLab Webhook | `gitlab-webhook-section.tsx` |
| Channels | `channels-section.tsx` |
| Generic Webhooks | `webhook-section.tsx` |
| Antigravity (preview-only in v1) | `antigravity-section.tsx` |

**C2 — Onboarding `setup` wizard** (`/projects/[slug]/setup`, `features/project-setup/WizardShell`). **Recommend DROP** — v2 settings Basics/Repository tabs already expose the same first-run fields. Port only if a guided first-run flow is explicitly wanted. *Pending product sign-off.*

**C3 — `/admin/*`** (users, devices, projects, audit). Backed by core `/api/admin/*` (gated by `ADMIN_EMAILS` + `requireAdmin`; the `is_ceo`/super-admin concept was removed 2026-05-31 — model is owner/member per project). Endpoints still exist, so a port is frontend-only. **Port only if a cloud admin UI is still wanted**; otherwise drop (admin ops via MCP/DB). *Pending product sign-off.*

## D. v1-deletion preconditions (gate for the ISS-395 retirement track)

Do **not** delete `packages/web` until all hold:

1. Every §B item dropped and every §C item resolved (ported-and-merged or explicitly dropped).
2. `V2_MIGRATED_PATHS` extended to map all remaining live v1 paths → `/v2` (or full cutover via `WEB_V2_BASE_PATH=""` + `NEXT_PUBLIC_BASE_PATH=""`).
3. No remaining inbound links/redirects to dropped routes.
4. Deleting v1 must not orphan core endpoints that **only** v1 calls — grep `packages/web-v2` and `packages/core` for usage before removing any backing route. (web-v2 declares its own local TS types, so a removed endpoint can still compile green while being runtime-broken.)
