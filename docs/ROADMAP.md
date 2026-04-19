# Jarvis Agents — Roadmap

> Public roadmap — what we build and why. Concrete timelines and commitments live in internal planning; this doc names the direction.

Last updated: 2026-04-19
Status: Alpha — expect breaking changes across `v0.x`

---

## 1. Positioning

**Jarvis Agents** is an open-source control plane for Claude Code. Issues arrive via webhooks from any source, flow through an extensible pipeline of agent skills, and every Claude Code session is captured, resumable, and auditable. Self-hosted. Apache-2.0.

Think: "Jenkins for Claude Code" — the CLI does the work; Jarvis Agents makes the work visible and coordinatable.

**Target users:**

1. **Engineering managers / tech leads (teams 3–20)** — need visibility into agent-driven work, audit trails, and shared pipeline discipline.
2. **Developers running Claude Code across many projects** — want persistent session state, resumability, and webhook-driven triggers.
3. **Regulated / agency teams** — need self-hosted Claude Code orchestration (cannot use cloud-only agents).

**What we are NOT:**
- Not a replacement for Claude Code CLI — we orchestrate it.
- Not a chat interface — the primary interface is a pipeline dashboard.
- Not a replacement for enterprise PM tools — no complex RBAC in `v0.x`.
- Not GitHub-only — webhook ingestion is source-agnostic.

---

## 2. Strategic themes

Five parallel tracks. Each release ships a slice across multiple themes.

| # | Theme | Question it answers |
|---|-------|---------------------|
| T1 | **Pipeline & orchestration** | Can issues flow through agent stages with gates and auto-triggers? |
| T2 | **Session capture & execution** | Can every Claude Code run be recorded, resumed, and routed across devices? |
| T5 | **Observability & trust** | Can teams see what agents did, pause when broken, audit decisions? |
| T3 | **Developer experience** | Desktop app, skill authoring, local MCP — does this feel native to a Claude Code user? |
| T4 | **Collaboration & multi-surface** | Real-time sync, mobile review, multi-project dashboards |

T5 is elevated to core (not polish layer) because observability is a defining differentiator.

---

## 3. Release direction

Versions are ship-when-ready. `v0.x` allows breaking changes.

### v0.1 — Control plane for Claude Code

**Focus:** T1 + T2 + T5.

- Projects, issues, 14-status pipeline with per-stage auto-run toggles
- Webhook ingestion (GitHub, generic JSON endpoint, custom sources)
- Claude Code session capture: streaming, resumable, token-tracked
- Desktop Tauri runner (spawns Claude CLI locally with git worktree)
- Optional Antigravity runner for browser-based tasks
- Built-in pipeline skills: forge-triage, forge-clarify, forge-plan, forge-code, forge-review, forge-test, forge-release, forge-fix
- User-authored skills (register into pipeline)
- Pipeline health dashboard
- MCP server at `/mcp` for external agent clients
- `docker compose up` one-command setup

### v0.2 — Onboarding + collaboration

**Focus:** T4 + T3.

- Mobile app (React Native) — issue review + session monitoring
- First-run onboarding wizard, example project, tutorial pipeline
- Skill library UI (search, install, rate, version)
- Session replay with diff timeline and jump-to-tool-call
- Webhook integration templates (Sentry, Stripe, GitHub events)

### v0.3 — Ecosystem

**Focus:** T3 + T2.

- Deep GitHub/GitLab integration (PR linkage, status sync)
- External MCP registry
- User-contributed skill marketplace
- Webhook-out to chat platforms

### v0.4 — Team scale

**Focus:** T1 + T4.

- Multi-workspace / cross-project views
- Roles: viewer, contributor, admin
- @mentions, email notifications, digest
- Skill permissions
- Rate limiting for agent execution

### v0.5 — Trust

**Focus:** T5.

- Metrics export (Prometheus)
- OpenTelemetry traces
- Audit log export
- Backup/restore tooling
- Public security review

### v1.0 — Contract freeze

- SemVer strict: breaking changes require deprecation cycle
- Skill format frozen
- LTS policy documented

**Post-1.0** (uncommitted):
- Plugin marketplace
- Optional managed SaaS tier (separate repo)
- Enterprise features (SSO, SCIM)

---

## 4. Feature development process

```
Idea → Proposal (RFC) → Accepted → Implemented → Released → Learned
```

RFCs required for:
- New public API surface (REST endpoint, MCP tool, UI route)
- Architecture changes (new service, schema migration)
- Breaking changes
- New pipeline stage or state machine change
- Cross-theme features

FCP: 10 calendar days with disposition (merge / close / postpone).

---

## 5. Prioritization framework

Score each competing feature: (user pain × 3) + (leverage × 2) + (strategic fit × 2) − effort.

Non-quantitative veto rules:
- **Security & data loss** always wins over features
- **No migration path** = not ready
- **Dogfood blocker** = not v0.1 material

---

## 6. What we are deliberately NOT doing

These are firm non-goals.

- **No multi-tenant SaaS** in core repo
- **No replacing Claude Code itself** — we orchestrate, we don't build an agent loop
- **No chat UI as primary interface** — this is a pipeline platform
- **No vendor-specific issue-source integrations in core** — plugins only for Jira-import, Asana-sync, etc.
- **No rich-text WYSIWYG editor** — markdown, always
- **No built-in messaging** — agents communicate via issues and comments
- **No feature-flag service** — env vars and config
- **No built-in CI runner** — use the host's CI
- **No language-specific tooling in core** — all features work across stacks
- **No enterprise RBAC in v0.x** — deliberately out of scope
- **No agent framework abstractions** — we don't reimplement LangGraph/CrewAI; we orchestrate anything that emits sessions

---

## 7. How to propose a change

- Open an issue with `kind/feature` + `area/roadmap`
- Reference which theme + version target
- If it displaces scope: state what it pushes out

---

## 8. References

- [Architecture](architecture.md)
- [BRAND.md](BRAND.md) — naming + style conventions
- [Contributing](../CONTRIBUTING.md)
