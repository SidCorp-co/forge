# Forge — Vision

> Single source of truth. README, landing, GitHub description derive from §1; on contradiction this doc wins — update the other.

Last updated: 2026-06-12 · Alpha, breaking changes across `v0.x` · Current: v0.3.x

## 1. What Forge is

Open-source software-lifecycle platform driven by Claude Code, running on devices you control. Apache-2.0, self-hostable, per-project configurable pipelines. Server never holds Claude credentials.

- **North star:** one person who truly understands and engages with their projects operates N of them through agents — watching, not working; joining only when an agent is truly stuck. Qualifier = understanding + engagement, not seniority.
- **Core system = the closed loop**, not any single part: pipeline *guarantees* skills + memory get used; *correct* skills + memory make the pipeline competent (wrong memory is fatal); every run compounds the next. Dashboard serves **control**: see, audit, stop, know where to join. Speed is a side effect.
- **Two metrics score every roadmap item:** ① user request → issue running in the right pipeline (onboarding friction, ISS-443) · ② human interventions per issue closed (operating friction, ISS-442). Both → 0.

## 2. Why · Who

Existing tools cover slices (Devin/Cursor: build, holds credentials; Jira/Linear: tickets, no orchestration; LangSmith: traces, no workflow). Forge = the end-to-end loop on operator-controlled infra.

For: operators delivering client work · internal multi-project teams · privacy-bound teams. **Not for:** anyone without Claude Code; chat-UI-first users; SSO/SOC2-today enterprises; anyone expecting Forge to provide the LLM.

## 3. What we build (shipped scope)

| Piece | One line |
|---|---|
| Pipeline engine | 18-status, per-stage auto-run or human-gate; shorten/extend/replace per project (`staging` soft-skipped) |
| Device runners | paired devices spawn `claude` locally, stream events; Tauri desktop (`packages/dev`) + headless Rust daemon (`packages/runner`) |
| Skills + memory | per-stage skills (built-in + user, facts-preamble), cloud memory with cognitive layer — the loop's accumulating half |
| Webhook ingestion | GitHub/Sentry/custom events → pipeline issues (= Maintain) |
| Session capture | full event log, 30-day retention, replayable |
| MCP + web-v2 UI | `/mcp` for external agents; dashboard canonical at `/` |

Direction (not built): **Idea → Spec → Design** as new stage types in the same pipeline.

## 4. What we're NOT

- Not a Claude Code replacement, not a chat UI, never an Anthropic-API credential holder.
- No multi-tenant SaaS in core, no enterprise RBAC in `v0.x`, no agent-framework abstractions.
- **Not yet (sequenced behind kernel trust, §5.10–11):** concurrency caps >1, skill marketplace, model-routing UI, UI polish beyond core loop. They unlock when metric ② trends down. Parked ideas → [IDEAS.md](IDEAS.md) (non-authoritative).

## 5. Principles

1. **Server never holds Claude credentials.**
2. **Lifecycle is the unit of work** — not code commits.
3. **Pipelines are configurable, not prescribed.**
4. **Issue is currency** — every decision links to an issue; no chat folklore.
5. **Docs-driven** — significant changes need an RFC first.
6. **Ship small, ship often** — `v0.x` may break.
7. **Security & migration > features.**
8. **Apache-2.0 core**; commercial stays in separate repos.
9. **Provider-agnostic where cheap, Claude-Code-first where needed.**
10. **State never lies** — a silent wedge, false failure, or unescalated stuck state is a kernel bug, above features.
11. **Kernel hard, policy soft** — job/session/run lifecycle is strict and invariant-guarded; pipelines/skills/prompts are user-shaped and change freely.

## 6. Roadmap (ships when ready, no dates)

- **Now (v0.3.x):** the two epics — kernel hardening (ISS-442: orphan gaps, false failures, failure taxonomy) + onboarding (ISS-443: init wizard, skill smoke-verify, bootstrap template, request intake).
- **Next (v0.4):** mobile read-only, session replay diff, webhook templates. Early Spec exploration.
- **Later:** Spec + Design stages, deep GitHub/GitLab, MCP registry, marketplace, roles, OTel, audit export, security review.
- **v1.0:** API + skill format + device protocol + stage contracts frozen, strict SemVer, LTS.

## 7. Using this doc

Read first (~3 min). Pivot protocol: change direction ⇒ edit THIS doc first, then dependents, then memory. Quarterly review §2/§4/§6. Related: [README](../README.md) · [architecture/](architecture/) · [modules/](modules/) · [proposals/](proposals/) · [rfcs/](rfcs/).
