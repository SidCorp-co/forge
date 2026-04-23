# Jarvis Agents — Release Roadmap (DRAFT)

> **Status:** Draft — release-notes-style view of [ROADMAP.md](ROADMAP.md). Built bottom-up from product capability ("what user sees") rather than top-down from strategic themes. Use [ROADMAP.md](ROADMAP.md) for the canonical theme + scope view; use this file when writing release announcements, blog posts, or stakeholder updates.
>
> **Last updated:** 2026-04-23
> **Multi-tenancy posture:** v0.1 ships multi-user single-tenant (Track A — see §Multi-tenancy). Workspaces / hard multi-tenant deferred to v0.4+ (RFC pending).

## Positioning (one-liner)

> *"Self-hosted control plane for Claude Code. Pair your machines as devices, route issues through an AI-driven 14-status pipeline. Your code and Claude credentials never leave your machines."*

Think **GitHub Actions self-hosted runners, for Claude Code**.

---

## v0.1 — Device-runner control plane (in build, Phase 2)

**Headline:** *"First public release. Self-host Jarvis Agents, pair your laptop, let Claude Code run through a 14-status issue pipeline on your own machine. Multi-user single-tenant out of the box."*

### What ships

- **Control plane** — Projects + issues + 14-status pipeline with per-stage auto-run toggles
- **Device-runner architecture** — Claude credentials never on server (per [ADR 0001](decisions/0001-device-runner-architecture.md), [ADR 0004](decisions/0004-no-claude-credentials-on-server.md))
  - Tauri desktop app (`dev`) — first-class
  - Headless CLI daemon (`forged`) — secondary
  - OS keychain (macOS / Windows / Linux)
- **Multi-user single-tenant** — invite by email, project membership roles (owner/admin/member), policy layer enforces project boundary on every endpoint (REST + WS + MCP)
- **Webhook ingestion** — GitHub, Sentry, generic JSON
- **MCP server** at `/mcp` — dual-principal auth (user JWT + device token)
- **Job event stream** — 30-day retention, WebSocket live broadcasts (room-scoped per principal)
- **Built-in pipeline skills** — forge-triage, clarify, plan, code, review, test, release, fix
- **Observability** — pipeline health dashboard, token usage tracking per project + device
- **Self-host** — `docker compose up` quickstart, single Postgres (data + jobs + pgvector embeddings), single Node process (~120 MB RAM idle)
- **Apache 2.0** license

### Multi-tenancy in v0.1

- **Track A — Multi-user single-tenant** ✅ shipped
  - One Jarvis deployment per team (3-20 users)
  - Multiple Jarvis instances if you need workspace isolation (run side-by-side, separate Postgres or schemas)
- **Track B — Workspaces (one instance, isolated workspaces)** ❌ not in v0.1 — deferred
- **Track C — Hard multi-tenant SaaS** ❌ never in core repo (per [ROADMAP §6](ROADMAP.md))

---

## v0.2 — Mobile returns + polish + cost routing

**Headline:** *"Mobile dashboard comes back. Skill library UI. Tag issues thrifty/standard/premium to save 5× on Claude tokens."*

### What ships

- **Mobile app** un-paused (per [ADR 0009](decisions/0009-mobile-app-paused-for-v0x.md) re-entry criteria) — read-only dashboard, job monitoring, issue comments, push notifications
- **Skill library UI** — browse, search, install, version
- **Session replay** — diff timeline, jump to specific tool call
- **Device label routing** — route jobs by capability (`gpu`, `macOS-arm64`, `has-docker`)
- **Webhook integration templates** — Sentry, Stripe, GitHub event variants
- **First-run onboarding wizard**
- **Cost-aware model routing — manual hint** (per [proposals/cost-aware-model-routing.md](proposals/cost-aware-model-routing.md)) — tag issues thrifty (Haiku 4.5) / standard (Sonnet 4.6) / premium (Opus 4.7); 5× savings vs all-Opus

---

## v0.3 — Ecosystem

**Headline:** *"Deeper Git platform integration. External skill marketplace. Webhook-out to Slack/Discord/Teams."*

### What ships

- **Deep GitHub / GitLab integration** — PR linkage, automatic status sync
- **External MCP server registry** — register third-party MCP servers per project
- **User-contributed skill marketplace**
- **Webhook-out to chat** — Slack, Discord, Teams notifications
- **Cost routing — auto-classify** — system suggests model tier based on job type

---

## v0.4 — Teams + workspaces

**Headline:** *"Multi-user projects with roles. Workspace isolation (Track B). Daily digests."*

### What ships

- **Multi-user projects** with explicit roles (viewer / contributor / admin)
- **Workspaces** — one Jarvis instance, multiple isolated workspaces (Track B multi-tenancy) — **RFC pending**
- **Shared devices** — team principal, multi-person access
- **Notifications + digests** — daily pipeline summary emails
- **Skill permissions** — restrict who can register/edit skills

---

## v0.5 — Trust & scale

**Headline:** *"Production-ready observability. Public security review. Redis-scale WebSocket."*

### What ships

- **Prometheus** metrics export
- **OpenTelemetry** traces (full, not minimal like v0.1)
- **Audit log export** — SIEM-compatible
- **Backup/restore** tooling
- **WebSocket → Redis pub/sub** — for larger deployments (>1000 concurrent sockets)
- **Public security review** published
- **Cost routing — budget-aware** — spend caps per project, per team

---

## v1.0 — Contract freeze

**Headline:** *"Production stable. SemVer strict. LTS policy. Skill format and device protocol frozen."*

### What ships

- **SemVer strict** — breaking changes require major bump
- **LTS policy** announced
- **Skill format frozen** — skills authored now keep working
- **Device-agent protocol frozen** — old devices keep connecting

---

## Post-1.0 (uncommitted)

- Plugin marketplace
- Linux headless agent (separate RFC)
- Team-device sharing (advanced)
- Optional managed tier (hosted Jarvis)

---

## Multi-tenancy decision matrix

| Track | Mô tả | Ship version | Use case |
|---|---|---|---|
| **A** | Multi-user single-tenant | ✅ v0.1 | Single team (3-20) per Jarvis instance |
| **B** | Workspaces (one instance, isolated workspaces) | v0.4 (RFC pending) | Multi-team in a single org sharing one Jarvis |
| **C** | Hard multi-tenant SaaS | ❌ never in core | Public hosted SaaS (out of scope) |

**For internal team use TODAY:** Track A + multi-instance pattern → spin up one Jarvis container per team, separate Postgres or schema. Total cost ~150-200 MB RAM per instance. No code changes required after v0.1 ships.

---

## Deliberate NOT-doing (cross-version)

| Not building | Why |
|---|---|
| Multi-tenant SaaS in core | Self-host is core value |
| Claude API usage | Spawn the CLI user already pays for |
| Credentials on server | [ADR 0004](decisions/0004-no-claude-credentials-on-server.md) — hard architectural commitment |
| Chat UI as primary surface | Pipeline dashboard is primary |
| Enterprise RBAC in v0.x | Premature; revisit at v1.x |
| Hosted managed runner | Contradicts device-runner spirit |
| Agent framework abstractions | Don't reimplement LangGraph / CrewAI |
| Rich-text WYSIWYG editor | Out of scope |
| Built-in messaging | Use Slack/Discord webhook-out instead |
| Built-in CI runner | Use GitHub Actions / `forged` daemon |

---

## Lifecycle

- This file is a **draft** until v0.1.0-rc.1 ships, then it migrates into `docs/RELEASES.md` (canonical release log) with each release tagged.
- Proposed but unplanned features land in `docs/proposals/` first; if accepted, they appear here under their target version.
- Versions ship when ready. `v0.x` allows breaking changes.

## Related

- [ROADMAP.md](ROADMAP.md) — canonical theme + scope view (T1-T5 strategic themes, prioritization formula)
- [RFC 0001](rfcs/0001-device-runner-architecture.md) — device-runner foundational design
- [RFC 0002](rfcs/0002-replace-strapi-with-hono-drizzle.md) — clean-break replacement of Strapi by `forge/core`
- [proposals/cost-aware-model-routing.md](proposals/cost-aware-model-routing.md) — v0.2 → v0.3 → v0.5 cost routing roadmap
- [proposals/core-strapi-decoupling.md](proposals/core-strapi-decoupling.md) — Phase 2.5 cutover plan
