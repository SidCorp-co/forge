# Forge — Vision

> Single source of truth. README, landing, GitHub description, site metadata derive from §1. On contradiction, this doc wins — update the other.

Last updated: 2026-06-11 · Status: Alpha — breaking changes across `v0.x` · Current: v0.3.x

---

## 1. What Forge is

- Open-source AI-powered software lifecycle platform, powered by Claude Code, running on devices you control.
- Vision: every stage idea→maintenance. Today: Build, Review, Launch, Maintain. Roadmap: Idea, Spec, Design.
- Pipelines user-configurable per project (not hardcoded). Apache-2.0, self-hostable. Server never holds your Claude credentials.
- **North star: work you can hand to agents without watching — and trust what the system reports back.** The metric is *human interventions per issue closed*, trending to zero. Every roadmap item is scored by how much it moves that number.

## 2. Why it exists

- Claude Code teams lack a unified full-lifecycle system: build/review in disconnected terminals, launch in deploy scripts, maintenance in tickets disconnected from AI work.
- Existing tools cover slices: Devin/Cursor cloud do Build but hold credentials + lock-in; Linear/Jira track tickets but don't orchestrate AI; LangSmith/Langfuse watch traces but don't drive workflow.
- Gap Forge fills: end-to-end lifecycle with Claude Code as engine, on operator-controlled infrastructure.

## 3. Who it's for

1. **Operators delivering software to external customers** — agencies, dev shops, software-on-demand studios, founder-engineers on paid client work. Forge is their production line.
2. **Internal teams managing software lifecycle** — IT/platform/engineering teams running multiple projects. Unifies delivery flow.
3. **Privacy-sensitive / regulated teams** — code and Claude credentials can't leave their infrastructure.

Not for: users without Claude Code; teams wanting chat UI as primary surface; enterprises needing SSO/SOC2 today; anyone expecting Forge to provide the LLM.

## 4. What we build

### 4a. Current scope — Build → Maintain

- **Pipeline engine** — issues flow through user-configurable stages, per-stage auto-run or human-gate. Default 18-status pipeline driving stages triage → clarify → plan → code → review → test → release (legacy `staging` stage is soft-skipped). Shorten/extend/replace per project.
- **Device-runner architecture** — pair laptops/desktops/CI boxes; each project binds a device pool, one runs at a time; devices spawn `claude` locally, stream stdout/tool-calls/diffs to server. Two form factors: Tauri desktop app (`packages/dev`) and headless Rust `forge-runner` daemon (`packages/runner`).
- **Webhook ingestion** — GitHub, Sentry, Stripe, custom → events become pipeline issues. This is how Maintain works in v0.1: alerts auto-create maintenance issues.
- **Session capture** — every job's full event log retained 30 days post-termination, replayable.
- **Skills** — built-in per-stage skills (forge-triage, forge-plan, forge-code, forge-review, etc.); user-authored skills register into stages.
- **MCP server** — `/mcp` exposes project data to external agent clients.
- **Web dashboard + Tauri desktop client** — multi-surface real-time view.

### 4b. Direction — Idea → Spec → Design (roadmap, not yet implemented)

Plug into the configurable pipeline as new stage types when shipped:

- **Idea** — capture loose ideas, validate, score, AI-assisted exploration.
- **Spec** — idea → structured PRD + acceptance criteria, AI-drafted from idea.
- **Design** — UX mock generation, architecture decisions, ADR drafting.

## 5. What we're NOT

- Not a Claude Code replacement — orchestrate the CLI, don't reimplement.
- Not a chat UI — primary surface is the lifecycle dashboard.
- Not a tool using the Anthropic API — never hold Claude credentials.
- No multi-tenant SaaS in core repo (hosted/managed tier may emerge separately if valuable).
- No enterprise RBAC in `v0.x` — separate RFC.
- No agent framework abstractions — orchestrate, not reimplement LangGraph/CrewAI.
- Idea/Spec/Design stages not yet implemented — roadmap items.

**Not *yet* — deliberately sequenced behind kernel trust (§6.10–11):** raising runner concurrency caps, skill marketplace, multi-model routing UI, UI polish beyond the core loop. Each of these multiplies the blast radius of a kernel bug; they unlock when *interventions per issue closed* trends down, not before. Parked ambitions live in [IDEAS.md](IDEAS.md) (non-authoritative).

## 6. Principles

1. **Server never holds Claude credentials.** Architectural commitment; a breach must not expose any user's Claude token.
2. **Lifecycle is the unit of work.** Every stage idea(someday)→maintenance is first-class, not just code commits.
3. **Pipelines are configurable, not prescribed.** Default 14-status pipeline is one option; operators shape their own.
4. **Issue is currency.** Every decision links to an issue. No Slack folklore.
5. **Docs-driven.** Significant changes need an RFC; read README/RFC before non-trivial code.
6. **Ship small, ship often.** `v0.x` allows breaks; many quick releases beat one perfect one.
7. **Security & migration > features.** Data loss / unmigrated breaks beat any roadmap item.
8. **Apache-2.0 for core.** Commercial features (if any) live in separate repos under separate licenses.
9. **Provider-agnostic where cheap, Claude-Code-first where needed.** Other runners pluggable; Claude Code CLI is the optimized default.
10. **State never lies.** Every visible status (issue, run, job, session) reflects reality even when an agent dies mid-run. A silent wedge, a false failure, or a stuck state with no escalation is a kernel bug — highest-priority class, above features.
11. **Kernel hard, policy soft.** The execution kernel (job/session/run lifecycle, dispatch, cleanup) is strict, invariant-guarded, slow-changing. Pipelines, skills, and prompts are user-shaped policy meant to change freely. Stabilize the kernel; never "stabilize" the policy.

## 7. Strategic themes

| # | Theme | Question it answers |
|---|-------|---------------------|
| T1 | Lifecycle pipeline (configurable) | Can operators shape their own pipeline and route work through it? |
| T2 | Device-runner system | Can devices pair, run jobs, and stream events reliably? |
| T3 | Developer experience | Desktop GUI + CLI daemon + skill authoring — does this feel native? |
| T4 | Collaboration & multi-surface | Real-time sync, multi-project, mobile (deferred) |
| T5 | Observability & trust | Can teams see what agents did, pause when broken, audit decisions? |
| T6 | Lifecycle expansion | Adding Idea / Spec / Design as native stages over time |

T1+T2+T5 core in `v0.x`. T6 ramps from `v0.3+`. T3+T4 important but not blocking.

## 8. Roadmap horizons

Versions ship when ready. No dates.

- **Shipped through v0.3** — configurable pipeline + device-runner control plane (desktop + headless `forge-runner`). Webhook ingestion. Built-in skills + skill-facts preamble. Session capture. MCP at `/mcp`. web-v2 UI (canonical at root since 2026-06-07). Memory v2 cognitive layer. Skill Studio.
- **Now (v0.3.x)** — harden the execution kernel (principles 10–11): close the orphan-job lifecycle gaps, kill false failures, classify failures so retries are smart — drive *interventions per issue closed* toward zero before widening throughput.
- **Next (v0.4)** — mobile returns (read-only), session replay diff timeline, webhook templates, onboarding wizard. Early Spec stage exploration.
- **Later (v0.3 → v0.5)** — **Spec** stage shipped (AI-assisted PRD), **Design** stage (mock + ADR), deep GitHub/GitLab integration, external MCP registry, user-contributed skill marketplace, multi-user projects with roles, Prometheus/OpenTelemetry, audit log export, public security review.
- **v1.0** — API + skill format + device-agent protocol + lifecycle stage contracts frozen, SemVer strict, LTS policy.
- **Someday** — **Idea** stage, Linux headless agent (separate RFC), plugin marketplace, optional managed tier (separate repo).

## 9. How to use this doc

- Every contributor reads this first (~10 min).
- Quarterly review of §3, §5, §8.
- Every major design proposal lands as an RFC in `docs/rfcs/` before code.
- When this doc contradicts code, this doc wins — update the other.

## 10. Related

- [README](../README.md) — onboarding, quickstart, packages
- [docs/architecture/](architecture/) — system design
- [docs/rfcs/](rfcs/) — accepted RFCs
- [docs/modules/](modules/) — per-feature docs
- [docs/proposals/](proposals/) — in-flight proposals
