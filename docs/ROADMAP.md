# Jarvis Agents — Roadmap

> Public roadmap — what we build and why. Concrete timelines and commitments live in internal planning; this doc names the direction.

Last updated: 2026-04-19
Status: Alpha — expect breaking changes across `v0.x`

---

## 1. Positioning

**Jarvis Agents** is an open-source project management + AI agent platform. It combines a Linear-style issue tracker with an agent orchestration layer that can plan, code, review, and ship work — driven by Claude CLI and cloud AI providers.

**Target users:**

1. **Solo developers / small teams (1–5)** — want an integrated PM + AI assistant without stitching 5 SaaS tools.
2. **Early-stage startups** — need traceable dev workflow with AI-assisted execution.
3. **Engineering managers** — want visibility into AI-assisted work, not a black box.

**What we are NOT:**
- Not a Jira/Linear replacement for enterprises (no complex RBAC, no Jira-grade reporting).
- Not a ChatGPT wrapper (agents are workflow-aware, not conversational).
- Not a no-code tool (we expect users can run docker-compose).

---

## 2. Strategic themes

Five parallel tracks. Each release ships a slice across multiple themes.

| # | Theme | Question it answers |
|---|-------|---------------------|
| T1 | **Core platform** | Can a team track work end-to-end here? |
| T2 | **AI agent orchestration** | Can agents execute real work, not demos? |
| T3 | **Developer experience** | Does this feel native to a dev's existing workflow? |
| T4 | **Collaboration & real-time** | Do multiple users see the same state instantly? |
| T5 | **Observability & trust** | Can maintainers see what agents do and why? |

---

## 3. Release direction

Versions are ship-when-ready, not calendar-driven. `v0.x` means breaking changes are allowed.

### v0.1 — Minimum viable public

**Focus:** T1 + T2.

- Projects, issues, comments, labels, activity log
- 14-status issue pipeline with WebSocket real-time
- Agent sessions (Claude CLI local + Antigravity cloud), streaming output
- Core `forge-*` pipeline skills (triage, plan, code, review, release)
- Desktop app (Tauri): local codebase access, git worktree, skill sync
- Zero-friction `docker-compose up` from clean clone

### v0.2 — Polish & mobile

**Focus:** T4 + T3.

- Mobile app (React Native) parity with web for core flows
- Skill library UX: search, install, rating
- Onboarding flow: first-run wizard, example project
- Eval framework: rate agent session quality
- Saved filters, keyboard shortcuts, bulk operations

### v0.3 — Ecosystem

**Focus:** T3 + T2.

- GitHub/GitLab integration (link issues to PRs, auto-status from merge)
- Webhook receivers (create issues from external events)
- MCP server extensibility (bring-your-own-MCP)
- Skill authoring from UI (not just filesystem)
- Public API docs (OpenAPI + reference site)

### v0.4 — Scale & teams

**Focus:** T1 + T4.

- Multi-workspace / cross-project views
- Roles: viewer, contributor, admin
- @mentions, email notifications, digest
- Permissions on skills (who can run what)
- Rate limiting for agent execution

### v0.5 — Production readiness

**Focus:** T5.

- Metrics export (Prometheus), OpenTelemetry traces
- Audit logs with filtering and export
- Backup/restore tooling
- Performance benchmarks published
- Public security review

### v1.0 — API contract frozen

- SemVer stable: breaking changes require deprecation cycle
- Skill format frozen
- LTS policy documented

**Post-1.0** (uncommitted):
- Plugin marketplace
- Enterprise features (SSO, SCIM)
- Mobile offline mode

---

## 4. Feature development process

```
Idea → Proposal (RFC) → Accepted → Implemented → Released → Learned
```

### Stage 1 — Idea capture

- Anyone can open `kind/feature` issue describing a **problem**, not a solution.
- Triage: label, route to owning theme (T1–T5).
- If clear and small → `kind/cleanup` or `good-first-issue`.
- If unclear or large → RFC required.

### Stage 2 — RFC (for significant changes)

Required for:
- New public API surface (REST endpoint, MCP tool, UI route).
- Architectural changes (schema migration, new service).
- Breaking changes.
- Cross-theme features.

RFCs live in `docs/rfcs/NNNN-name.md`. Final Comment Period: 10 calendar days.

### Stage 3 — Implementation

- Tracking issue created on accept.
- Break into subtasks.
- Follow pipeline: triage → plan → approved → code → review → tested → staging → released.

### Stage 4 — Release

- CHANGELOG entry per release.
- Deprecations shipped ≥1 release before removal.
- Migration guide if breaking.

---

## 5. Prioritization framework

When two features compete for the same release slot, weigh:

- **User pain** (3×) — how many user-reported issues linked?
- **Leverage** (2×) — how many downstream features unlock?
- **Strategic fit** (2×) — T1/T2 > T3/T4 > T5 for early releases.
- **Effort** (-1×) — week-person estimate.

Non-quantitative veto rules:
- **Security & data loss** always wins over features.
- **No migration path** = not ready.
- **Dogfood blocker** = not v0.1 material.

---

## 6. What we are deliberately NOT doing

Saying "no" is how we ship. These are firm non-goals:

- **No multi-tenant SaaS** in core repo.
- **No vendor-specific integrations in core** (plugins only for Jira-import, Asana-sync, etc.).
- **No rich-text WYSIWYG editor** — markdown-first, always.
- **No built-in chat/messaging** — Discord/Slack for humans, issues for work.
- **No feature flag service** — env vars + config.
- **No built-in CI runner** — use the host's CI.
- **No language-specific tooling in core** — all features work across stacks.

---

## 7. How to propose a change

- Open an issue with `kind/feature` + `area/roadmap`.
- Reference which theme + version target.
- If it displaces scope from a release: state what it pushes out.

---

## 8. References

- [Architecture](architecture.md)
- [BRAND.md](BRAND.md) — naming + style conventions
- [Contributing](../CONTRIBUTING.md)
