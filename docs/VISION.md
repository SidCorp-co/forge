# Forge — Vision

> Single source of truth. Every other surface (README, landing, GitHub description,
> site metadata) derives from §1. When this doc contradicts another spec, this doc
> wins — update the other.

Last updated: 2026-04-29
Status: Alpha — expect breaking changes across `v0.x`

---

## 1. What Forge is

**Forge** is the open-source AI-powered software lifecycle platform. Powered by
Claude Code, running on devices you control. Vision: manage every stage from
idea to maintenance — today Forge covers Build, Review, Launch, and Maintain;
Idea, Spec, and Design are on the roadmap. Pipelines are user-configurable per
project, not hardcoded. Apache-2.0, self-hostable. The server never holds your
Claude credentials.

## 2. Why it exists

Software delivery teams using Claude Code lack a unified system for the full
lifecycle. Build/review work happens in disconnected terminals; launch is in
deploy scripts; maintenance happens in tickets that don't connect back to the
AI work. Existing tools cover slices: Devin and Cursor cloud handle Build but
hold credentials and lock you into a vendor; Linear and Jira track tickets but
don't orchestrate AI; LangSmith and Langfuse watch traces but don't drive
workflow. Nobody integrates the lifecycle end-to-end with Claude Code as the
engine, on infrastructure the operator controls. That's the gap Forge fills.

## 3. Who it's for

1. **Operators delivering software to external customers** — agencies, dev
   shops, software-on-demand studios, founder-engineers running paid client
   work. Forge is their production line.
2. **Internal teams managing software lifecycle** — IT teams, platform teams,
   engineering teams running multiple projects. Forge unifies their delivery
   flow.
3. **Privacy-sensitive / regulated teams** — code and Claude credentials cannot
   leave their infrastructure.

Not for: users without Claude Code; teams wanting a chat UI as the primary
surface; enterprises needing SSO/SOC2 today; anyone expecting Forge to provide
the LLM.

## 4. What we build

### 4a. Current scope — Build → Maintain

- **Pipeline engine** — issues flow through user-configurable stages with
  per-stage auto-run or human-gate. The default 14-status pipeline covers
  triage → clarify → plan → code → review → test → release → staging. You can
  shorten, extend, or replace it per project.
- **Device-runner architecture** — pair laptops, desktops, CI boxes into Forge.
  Each project binds to a pool of devices; one runs at a time. Devices spawn
  `claude` locally, stream stdout/tool-calls/diffs to the server.
- **Webhook ingestion** — GitHub, Sentry, Stripe, custom — events become
  issues that enter the pipeline. This is how Maintain works in v0.1: incoming
  alerts auto-create maintenance issues.
- **Session capture** — every job's full event log retained 30 days
  post-termination, replayable.
- **Skills** — built-in skills for each pipeline stage (forge-triage,
  forge-plan, forge-code, forge-review, etc.). User-authored skills register
  into stages.
- **MCP server** — `/mcp` endpoint exposes project data to external agent
  clients.
- **Web dashboard + Tauri desktop client** — multi-surface real-time view.

### 4b. Direction — Idea → Spec → Design (roadmap, not yet implemented)

These stages will plug into the configurable pipeline as new stage types when
shipped:

- **Idea** — capture loose ideas, validate, score, AI-assisted exploration.
- **Spec** — convert idea to structured PRD, acceptance criteria, AI-drafted
  from idea.
- **Design** — UX mock generation, architecture decisions, ADR drafting.

## 5. What we're NOT

- Not a Claude Code replacement — we orchestrate the CLI, we don't reimplement.
- Not a chat UI — primary surface is the lifecycle dashboard.
- Not a tool that uses the Anthropic API — we never hold Claude credentials.
- No multi-tenant SaaS in the core repo. A hosted/managed tier may emerge
  separately if proven valuable.
- No enterprise RBAC in `v0.x`. No team/org model in `v0.x` — separate RFC.
- No Linux headless agent in `v0.x` — follow-up RFC.
- No mobile in `v0.x` — `packages/app/` is paused, returns in `v0.2+`.
- No agent framework abstractions — we orchestrate, not reimplement
  LangGraph/CrewAI.
- Idea, Spec, Design stages not yet implemented — roadmap items.

## 6. Principles

1. **Server never holds Claude credentials.** Architectural commitment, not
   preference. A breach must not expose any user's Claude token.
2. **Lifecycle is the unit of work.** Not just code commits — every stage from
   idea (someday) to maintenance is a first-class concern.
3. **Pipelines are configurable, not prescribed.** The default 14-status
   pipeline is one option; operators shape their own.
4. **Issue is currency.** Every decision links to an issue. No Slack folklore.
5. **Docs-driven.** Significant changes need an RFC. Read README/RFC before
   non-trivial code.
6. **Ship small, ship often.** `v0.x` allows breaks. Many quick releases beat
   one perfect one.
7. **Security & migration > features.** Data loss or unmigrated breaks beat
   any roadmap item.
8. **Apache-2.0 for core.** Commercial features (if any emerge) live in
   separate repos under separate licenses.
9. **Provider-agnostic where cheap, Claude-Code-first where needed.** Other
   runners are pluggable; Claude Code CLI is the optimized default.

## 7. Strategic themes

| # | Theme | Question it answers |
|---|-------|---------------------|
| T1 | Lifecycle pipeline (configurable) | Can operators shape their own pipeline and route work through it? |
| T2 | Device-runner system | Can devices pair, run jobs, and stream events reliably? |
| T3 | Developer experience | Desktop GUI + CLI daemon + skill authoring — does this feel native? |
| T4 | Collaboration & multi-surface | Real-time sync, multi-project, mobile (deferred) |
| T5 | Observability & trust | Can teams see what agents did, pause when broken, audit decisions? |
| T6 | Lifecycle expansion | Adding Idea / Spec / Design as native stages over time |

T1 + T2 + T5 are core in `v0.x`. T6 ramps up from `v0.3+`. T3 + T4 are
important but not blocking.

## 8. Roadmap horizons

Versions ship when ready. No dates.

- **Now (v0.1.x)** — stabilize Build / Review / Launch / Maintain on the default
  pipeline. User-configurable pipeline per project. Device-runner control
  plane. Webhook ingestion. Built-in skills (forge-triage / clarify / plan /
  code / review / test / release / fix). Session replay. MCP at `/mcp`.
  Apache-2.0 quickstart.
- **Next (v0.2)** — mobile returns (read-only), skill library UI, session
  replay diff timeline, webhook templates, onboarding wizard. Early Spec stage
  exploration.
- **Later (v0.3 → v0.5)** — **Spec** stage shipped (AI-assisted PRD), **Design**
  stage (mock + ADR), deep GitHub/GitLab integration, external MCP registry,
  user-contributed skill marketplace, multi-user projects with roles,
  Prometheus / OpenTelemetry, audit log export, public security review.
- **v1.0** — API + skill format + device-agent protocol + lifecycle stage
  contracts frozen, SemVer strict, LTS policy.
- **Someday** — **Idea** stage, Linux headless agent (separate RFC), plugin
  marketplace, optional managed tier (separate repo).

## 9. How to use this doc

- Every contributor reads this first. ~10 minutes.
- Quarterly review of §3, §5, §8.
- Every major design proposal lands as an RFC in `docs/rfcs/` before code.
- When this doc contradicts code, this doc wins — update the other.

## 10. Related

- [README](../README.md) — onboarding, quickstart, packages
- [docs/architecture/](architecture/) — system design
- [docs/rfcs/](rfcs/) — accepted RFCs
- [docs/modules/](modules/) — per-feature docs
- [docs/proposals/](proposals/) — in-flight proposals
