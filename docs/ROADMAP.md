# Forge — Roadmap

> Public roadmap — what we build and why. Concrete timelines and commitments live in internal planning; this doc names the direction.

Last updated: 2026-04-19
Status: Alpha — expect breaking changes across `v0.x`

---

## 1. Positioning

**Forge** lets you remote-control your local Claude Code from a web dashboard. You keep your Claude subscription and your code on your own machines; Forge pairs them as **devices**, routes incoming issues through a 14-status pipeline, and captures every job so teams have visibility, resumability, and audit.

The architectural story: **the server never holds your Claude credentials.** Think GitHub Actions self-hosted runners, for Claude Code.

**Target users:**

1. **Engineering managers / tech leads (teams 3–20) already using Claude Code** — need visibility into agent-driven work, audit trails, multi-project coordination. Willing to self-host for control.
2. **Developers who run Claude Code across many projects** — want persistent job state, resumability, webhook-driven triggers, multi-device pooling (laptop + desktop + CI).
3. **Privacy-sensitive / regulated / agency teams** — cannot send code to third-party clouds. Forge's architecture guarantees Claude credentials and code never leave your devices.

**What we are NOT:**
- Not a replacement for Claude Code — we orchestrate, we don't reimplement.
- Not a chat UI — the primary interface is a pipeline dashboard.
- Not a tool that uses Anthropic's API — we spawn the `claude` CLI you already pay for.
- Not enterprise PM — no complex RBAC in `v0.x`.
- Not GitHub-only — webhook ingestion is source-agnostic.

See [RFC 0001: Device-runner architecture](rfcs/0001-device-runner-architecture.md) for the foundational design decision.

---

## 2. Strategic themes

Five parallel tracks. Each release ships a slice across multiple themes.

| # | Theme | Question it answers |
|---|-------|---------------------|
| T1 | **Pipeline & orchestration** | Can issues flow through agent stages with gates and auto-triggers? |
| T2 | **Device-runner system** | Can devices pair, run jobs, and stream events reliably? |
| T5 | **Observability & trust** | Can teams see what agents did, pause when broken, audit decisions? |
| T3 | **Developer experience** | Desktop GUI + CLI daemon, skill authoring — does this feel native to a Claude Code user? |
| T4 | **Collaboration & multi-surface** | Real-time sync, multi-project dashboards, mobile (v0.2+) |

T5 (observability) is core from v0.1, not a polish layer. T2 (device-runner) is the architectural center.

---

## 3. Release direction

Versions ship when ready. `v0.x` allows breaking changes.

### v0.1 — Device-runner control plane

**Focus:** T1 + T2 + T5.

**Control plane:**
- Projects, issues, 14-status pipeline with per-stage auto-run toggles
- Webhook ingestion (GitHub, generic JSON, custom)
- Job queue + dispatcher
- JobEvent stream (30-day retention after terminal state)
- WebSocket with room-scoped broadcasts
- MCP server at `/mcp` with dual-principal auth
- `docker compose up` quickstart

**Device agents:**
- Tauri `dev` GUI (first-class)
- `forged` CLI daemon (secondary form factor)
- Shared `agent-core` Rust crate
- Pair/revoke UI, pairing codes
- OS keychain storage (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- Auto-update via GitHub Releases
- Platform priority: Linux desktop first-class, macOS/Windows supported

**Auth + policy:**
- Dual-principal (user JWT + device token)
- Shared policy layer — no ad-hoc controller checks
- JWT 7d + refresh rotation
- Rate limits on auth + pairing endpoints
- Email verification at first project creation

**Pipeline skills:**
- Built-in: forge-triage, forge-clarify, forge-plan, forge-code, forge-review, forge-test, forge-release, forge-fix
- User-authored skills register into pipeline stages

**Observability:**
- Pipeline health dashboard
- Job event replay
- Token usage tracking per project, per device

### v0.2 — Mobile returns + polish

**Focus:** T4 + T3.

- Mobile app un-paused (read-only dashboard + job monitoring)
- Device label routing (`gpu`, `macOS-arm64`, `has-docker`)
- Skill library UI (search, install, rate, version)
- Session replay with diff timeline and jump-to-tool-call
- Webhook integration templates (Sentry, Stripe, GitHub event variants)
- First-run onboarding wizard

### v0.3 — Ecosystem

- Deep GitHub / GitLab integration (PR linkage, status sync)
- External MCP registry
- User-contributed skill marketplace
- Webhook-out to chat platforms

### v0.4 — Teams

- Multi-user projects
- Roles (viewer, contributor, admin)
- Shared devices (team principal)
- Notifications, digests
- Skill permissions

### v0.5 — Trust & scale

- Prometheus metrics export
- OpenTelemetry traces
- Audit log export
- Backup/restore tooling
- WebSocket → Redis pub/sub (for larger deployments)
- Public security review

### v1.0 — Contract freeze

- SemVer strict, LTS policy
- Skill format frozen
- Device-agent protocol frozen

**Post-1.0 (uncommitted):**
- Plugin marketplace
- Linux headless agent (separate RFC)
- Team-device sharing
- Optional managed tier

---

## 4. Feature development process

```
Idea → Proposal (RFC) → Accepted → Implemented → Released → Learned
```

RFCs required for:
- New public API surface (REST endpoint, MCP tool, WebSocket event)
- Architecture changes (new service, schema migration)
- Breaking changes
- New pipeline stage or state machine change
- Device-agent protocol changes
- New principal class (team, shared device)

FCP: 10 calendar days.

RFC template: see [rfcs/0001](rfcs/0001-device-runner-architecture.md) or adapt from [Rust RFC template](https://github.com/rust-lang/rfcs/blob/master/0000-template.md).

---

## 5. Prioritization framework

Score: (user pain × 3) + (leverage × 2) + (strategic fit × 2) − effort.

Non-quantitative vetoes:
- **Security & data loss** always wins.
- **Credential boundary violation** — if any feature would require the server to hold Claude credentials, it's rejected architecturally, not deprioritized.
- **No migration path** = not ready.
- **Dogfood blocker** = not v0.1.

---

## 6. What we are deliberately NOT doing

- **No multi-tenant SaaS in core repo.**
- **No Claude API usage.** We spawn the CLI, we don't call the API.
- **No Claude credential storage on the server.** Architectural commitment.
- **No replacing Claude Code itself.**
- **No chat UI as primary interface.**
- **No vendor-specific issue-source integrations in core** — plugins only.
- **No rich-text WYSIWYG editor.**
- **No built-in messaging.**
- **No feature-flag service.**
- **No built-in CI runner.**
- **No enterprise RBAC in v0.x.**
- **No team / organization model in v0.x** — separate RFC.
- **No hosted (managed) runner** — contradicts device-runner spirit.
- **No Linux headless agent in v0.x** — follow-up RFC planned.
- **No mobile app in v0.x** — paused, returns v0.2+.
- **No agent framework abstractions** — we orchestrate, not reimplement LangGraph/CrewAI.

---

## 7. How to propose a change

- Open an issue with `kind/feature` + `area/roadmap`
- Reference which theme + version target
- If it displaces scope: state what it pushes out

---

## 8. References

- [Architecture](architecture/system-overview.md)
- [RFC 0001: Device-runner architecture](rfcs/0001-device-runner-architecture.md)
- [BRAND.md](BRAND.md)
- [Contributing](../CONTRIBUTING.md)
