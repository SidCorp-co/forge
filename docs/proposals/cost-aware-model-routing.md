# Proposal: Cost-aware model routing

- **Status:** Draft proposal (pre-RFC)
- **Date:** 2026-04-20
- **Target version:** v0.2 (manual hint) → v0.3 (auto-classify) → v1.0 (budget-aware)
- **Author:** @junixlabs

## Problem

Every job in Jarvis Agents spawns a Claude CLI session. The cost of that session scales with model tier: Haiku 4.5 input is ~$0.80/M tokens; Opus 4.7 is ~$15/M. For a team running 50+ jobs/day, all-Opus vs all-Haiku is an 18× cost difference — hundreds of dollars per month at moderate usage.

Today, Forge does not differentiate: every job uses the project-default model or whatever `claude` picks up from the environment. This means:

- Boilerplate scaffolding (Haiku-worthy) burns Opus tokens
- Architectural decisions (Opus-worthy) sometimes run on Haiku and miss edge cases, causing rework
- Teams have no way to pre-budget or cap spend
- Dogfooding data shows 60–80% of pipeline jobs (CRUD, config, docs, tests) don't need a premium model

This is a real adoption blocker. The tool should help teams spend smart, not just spend.

## Insight

Across a realistic project pipeline, jobs fall into tiers:

| Tier | Examples | Right model |
|------|----------|-------------|
| **Thrifty** | Boilerplate, scaffolding, config edits, CRUD following patterns, doc updates, test-after-fixture | Haiku 4.5 |
| **Standard** | Integrations with judgment, most forge-code runs, moderate refactors | Sonnet 4.6 |
| **Premium** | Schema design, policy/security-critical code, state machine semantics, cross-cutting architecture | Opus 4.7 |

Our own Phase 2 work estimates **5× savings** by routing 80% of jobs to Haiku and reserving Sonnet for the 20% that genuinely benefit from deeper reasoning.

If Jarvis Agents ships this as a feature, every user gets the same savings. It becomes a concrete adoption story: "Runs Claude Code cheaper than you do manually — without losing quality."

## Principle

**Route each job to the cheapest model that can complete the task at acceptable quality.**

Never the smart-by-default assumption; never the reverse either. The routing must be:

- **Explicit by default** — user (or pipeline config) names the tier. No surprise spend.
- **Informed** — the system can suggest a tier but doesn't force it.
- **Overridable** — one-off jobs can bump tier; project defaults can pin a tier.
- **Measurable** — cost per job is recorded; cost per issue, project, user, week is visible.

## Phased roadmap

### v0.2 — Manual tier hint (ship first)

**Scope:**
- Add `modelTier` field to `Job` schema: `thrifty | standard | premium | auto`
- Add `modelTier` field to `Skill` schema (default for that skill)
- Add project default `modelTier` in project settings
- Resolution order at dispatch: job → skill → project → global default
- Dispatcher maps tier to concrete model (per-provider mapping config)
- UI: model-tier selector on job creation + issue view; color-coded in Kanban (thrifty/standard/premium badges)
- Cost recording: record estimated + actual tokens per job; expose in dashboard

**Exit criteria:** users can mark an issue as thrifty and see the job run on Haiku.

### v0.3 — Auto-classification

**Scope:**
- Heuristic classifier runs at issue creation (or manual trigger)
- Signals: description length, keywords (e.g. "schema", "policy" → premium; "config", "docs" → thrifty), linked file extensions, pipeline stage
- Optional: lightweight LLM call (Haiku itself) to classify
- Output: `modelTier: auto` resolves to suggestion at dispatch time
- User can accept or override the suggestion
- Learning loop: track override rate per classification; adjust heuristics

**Exit criteria:** 80% of new issues get correct auto-tier with <20% override rate.

### v1.0 — Budget-aware dispatch

**Scope:**
- Per-project budget (daily/weekly/monthly caps, separately per tier)
- Dispatcher defers or downgrades jobs when budget nears cap
- Alert thresholds: 50%, 80%, 100%
- Budget report in project settings
- Optional: per-user budgets (contributor A can't blow the team's Opus budget)

**Exit criteria:** team can set "$50/month premium budget" and dispatcher enforces.

## Mechanism sketch

### Schema additions

```ts
// jobs
modelTier: text('model_tier', { enum: ['thrifty', 'standard', 'premium', 'auto'] })
  .default('standard'),
modelResolved: text('model_resolved'),  // e.g. "claude-haiku-4-5"
tokensInput: integer('tokens_input'),
tokensOutput: integer('tokens_output'),
costEstimatedUsd: numeric('cost_estimated_usd', { precision: 10, scale: 4 }),

// skills
defaultModelTier: text('default_model_tier', { enum: [...] }),

// projects
defaultModelTier: text('default_model_tier', { enum: [...] }),
monthlyBudgetUsd: numeric('monthly_budget_usd'),  // v1.0
```

### Resolution at dispatch

```ts
function resolveModelTier(job, skill, project): ModelTier {
  if (job.modelTier !== 'auto') return job.modelTier
  if (skill.defaultModelTier) return skill.defaultModelTier
  if (project.defaultModelTier) return project.defaultModelTier
  return 'standard'  // safe default
}

function resolveModel(tier: ModelTier, provider: 'anthropic' | ...) {
  return MODEL_MAP[provider][tier]
  // { anthropic: { thrifty: 'claude-haiku-4-5', standard: 'claude-sonnet-4-6', ... } }
}
```

### UI sketch

- **Job list Kanban** — each card has a small tier badge: 🟢 thrifty · 🟡 standard · 🟣 premium
- **Issue detail** — model-tier selector with inline cost preview ("~$0.40" / "~$3.60" / "~$15")
- **Pipeline settings** — table of stages × tier defaults per project
- **Budget dashboard** (v1.0) — month-to-date spend, projection, breakdown

### Provider abstraction

Tier names are provider-agnostic. Mapping lives in config:

```ts
{
  anthropic: {
    thrifty: 'claude-haiku-4-5',
    standard: 'claude-sonnet-4-6',
    premium: 'claude-opus-4-7'
  },
  openai: {
    thrifty: 'gpt-4o-mini',
    standard: 'gpt-4o',
    premium: 'gpt-4.1'
  }
}
```

Users can override per project. Enables "we use Haiku for thrifty, but Sonnet 4.6 for standard AND premium" (= 2-tier strategy).

## Why this is a differentiator

Every AI coding agent today picks one model and sticks with it. Forge is the first tool that says: "your pipeline has tasks of different shape; use different brain for each." This reframes the product's value proposition:

- Claude Code alone: use one model per session
- Devin: cloud-only, one model
- Cursor: model picker per request
- **Forge: pipeline-aware cost-optimized routing, with audit trail and budget guardrails**

The cost savings story ("cuts AI spend 60–80% without losing quality") is a concrete line in marketing copy that competitors can't easily match without rebuilding their orchestration layer.

## Dogfooding during Phase 2

The principle is shipping before the feature. For Phase 2 development:

- Every Phase 2 issue has a manual "Suggested model" note in its description (ISS-136 through ISS-142 demonstrate)
- Developers running forge-code manually select model when dispatching
- After each phase: measure actual token spend per issue, compare to estimate, refine the tiering rubric
- The learnings feed directly into the v0.2 heuristic classifier

This is the simplest form of the feature: human-in-the-loop classifier. When we ship v0.2, we're codifying the rubric we used on ourselves.

## Drawbacks

1. **Decision fatigue** — users have one more field to think about per issue. Mitigation: `auto` default + good heuristics in v0.3.
2. **Wrong-tier retry cost** — Haiku fails, requires Sonnet retry. Near-break-even if retry rate < 15%. Observable and tunable.
3. **Provider abstraction leakage** — tier names feel opinionated. Users who want "exactly Sonnet 4.6 Oct release" can override at model level.
4. **Budget enforcement adds scheduling complexity** — v1.0 only; v0.2/v0.3 have no budget gate.

## Alternatives considered

1. **Always use Sonnet** — simpler but 3× more expensive than tiered. Rejected.
2. **Always use Haiku, retry with Sonnet on failure** — cheap but retry rate on complex tasks could reach 40%, negating savings. Rejected as default; retained as user-selectable strategy.
3. **Let the LLM pick its own model** — recursive; adds latency; model might be biased toward its own tier. Rejected.
4. **Pure rule-based heuristic (no tier field)** — inflexible; can't override. Rejected — we need explicit control first.

## Prior art

- **CI runners matrix** — GitHub Actions lets repos pick runner size per job. This is that, for LLMs.
- **Kubernetes resource classes** — pods request CPU/RAM class; scheduler routes. Same pattern.
- **Cursor's model picker** — per-request, UI-level. We do it at pipeline level with persistence.

## Open questions

- Should tier affect agent behavior (e.g., premium allows more tool calls)? Separate concern; probably no.
- Should we record "what tier WAS used" vs "what tier SHOULD HAVE been" for training data? Yes, but not blocking v0.2.
- Could we expose this as an MCP tool so external agents can set tier for their own jobs? Likely yes, v0.3.

## Success metrics (post-ship)

- 60%+ of jobs run on thrifty tier
- Average cost per issue drops ≥50% from v0.1 baseline
- Retry rate for thrifty jobs stays ≤15%
- User satisfaction (CSAT-style survey on tier auto-suggestions) > 4/5

## Next steps

1. Accept this proposal at v0.2 roadmap discussion
2. Upgrade to full RFC when schema + API shape decided
3. Create tracking issue (see Forge ISS below)
4. Use Phase 2 dev work as the calibration dataset
