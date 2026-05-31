# Proposal: Cost-aware model routing

Route each job to the cheapest model that can complete it at acceptable quality.

- **Status:** Draft proposal (pre-RFC) · **Date:** 2026-04-20 · **Author:** @junixlabs
- **Target version:** v0.2 (manual hint) → v0.3 (auto-classify) → v1.0 (budget-aware)

## Problem

- Every job spawns a Claude CLI session; cost scales with tier — Haiku 4.5 input ~$0.80/M tokens, Opus 4.7 ~$15/M. At 50+ jobs/day all-Opus vs all-Haiku = 18× difference (hundreds $/mo).
- Forge doesn't differentiate today: every job uses project-default model or env. Consequences:
  - Boilerplate (Haiku-worthy) burns Opus tokens; architecture (Opus-worthy) sometimes runs on Haiku → missed edge cases, rework.
  - No way to pre-budget or cap spend.
  - Dogfooding: 60–80% of jobs (CRUD, config, docs, tests) don't need a premium model. Real adoption blocker.

## Insight

| Tier | Examples | Right model |
|------|----------|-------------|
| **Thrifty** | Boilerplate, scaffolding, config edits, CRUD following patterns, doc updates, test-after-fixture | Haiku 4.5 |
| **Standard** | Integrations with judgment, most forge-code runs, moderate refactors | Sonnet 4.6 |
| **Premium** | Schema design, policy/security-critical code, state machine semantics, cross-cutting architecture | Opus 4.7 |

- Phase 2 estimate: **5× savings** routing 80% to Haiku, reserving Sonnet for the 20%. Ships same savings to every user — adoption story: "Runs Claude Code cheaper than you do manually — without losing quality."

## Principle

Route each job to the cheapest model that can complete the task at acceptable quality. Routing must be:

- **Explicit by default** — user/pipeline config names the tier; no surprise spend.
- **Informed** — system suggests but doesn't force.
- **Overridable** — one-off bump tier; project defaults pin a tier.
- **Measurable** — cost per job recorded; cost per issue/project/user/week visible.

## Phased roadmap

### v0.2 — Manual tier hint (ship first)

- Add `modelTier` to `Job` schema: `thrifty | standard | premium | auto`
- Add `modelTier` to `Skill` schema (skill default); add project default `modelTier` in settings
- Resolution order at dispatch: job → skill → project → global default
- Dispatcher maps tier → concrete model (per-provider mapping config)
- UI: tier selector on job creation + issue view; color-coded Kanban badges
- Cost recording: estimated + actual tokens per job; expose in dashboard
- **Exit:** users mark an issue thrifty and see the job run on Haiku.

### v0.3 — Auto-classification

- Heuristic classifier at issue creation (or manual trigger)
- Signals: description length, keywords ("schema"/"policy" → premium; "config"/"docs" → thrifty), linked file extensions, pipeline stage
- Optional lightweight LLM call (Haiku) to classify
- `modelTier: auto` resolves to suggestion at dispatch; user accepts/overrides
- Learning loop: track override rate per classification; adjust heuristics
- **Exit:** 80% of new issues get correct auto-tier with <20% override rate.

### v1.0 — Budget-aware dispatch

- Per-project budget (daily/weekly/monthly caps, separately per tier)
- Dispatcher defers/downgrades jobs when budget nears cap
- Alert thresholds: 50%, 80%, 100%; budget report in settings
- Optional per-user budgets
- **Exit:** team sets "$50/month premium budget" and dispatcher enforces.

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

- **Kanban** — tier badge: 🟢 thrifty · 🟡 standard · 🟣 premium
- **Issue detail** — tier selector with inline cost preview ("~$0.40" / "~$3.60" / "~$15")
- **Pipeline settings** — table of stages × tier defaults per project
- **Budget dashboard** (v1.0) — month-to-date spend, projection, breakdown

### Provider abstraction

Tier names are provider-agnostic; mapping in config. Users override per project (e.g. 2-tier: Haiku for thrifty, Sonnet 4.6 for standard AND premium).

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

## Why this is a differentiator

Other agents pick one model and stick with it. Forge: "use a different brain per task shape."

- Claude Code alone: one model per session · Devin: cloud-only, one model · Cursor: model picker per request
- **Forge: pipeline-aware cost-optimized routing, with audit trail + budget guardrails**
- Marketing line ("cuts AI spend 60–80% without losing quality") competitors can't match without rebuilding orchestration.

## Dogfooding during Phase 2

Principle ships before the feature (human-in-the-loop classifier):

- Every Phase 2 issue carries a manual "Suggested model" note (ISS-136 through ISS-142 demonstrate)
- Devs select model when dispatching forge-code manually
- After each phase: measure actual spend per issue vs estimate, refine the rubric
- Learnings feed the v0.2 heuristic classifier; v0.2 codifies the rubric we used on ourselves

## Drawbacks

1. **Decision fatigue** — one more field per issue. Mitigation: `auto` default + v0.3 heuristics.
2. **Wrong-tier retry cost** — Haiku fails → Sonnet retry; near break-even if retry rate < 15%. Observable, tunable.
3. **Provider abstraction leakage** — tier names feel opinionated; override at model level for exact release.
4. **Budget enforcement complexity** — v1.0 only; v0.2/v0.3 have no budget gate.

## Alternatives considered

1. **Always Sonnet** — simpler, 3× more expensive than tiered. Rejected.
2. **Always Haiku, retry Sonnet on failure** — cheap but retry rate could reach 40%, negating savings. Rejected as default; retained as user-selectable strategy.
3. **LLM picks own model** — recursive; adds latency; self-tier bias. Rejected.
4. **Pure rule-based heuristic (no tier field)** — inflexible, can't override. Rejected — need explicit control first.

## Prior art

- **CI runners matrix** — GitHub Actions picks runner size per job; this is that, for LLMs.
- **Kubernetes resource classes** — pods request CPU/RAM class; scheduler routes. Same pattern.
- **Cursor's model picker** — per-request, UI-level; we do it at pipeline level with persistence.

## Open questions

- Should tier affect agent behavior (e.g. premium → more tool calls)? Separate concern; probably no.
- Record "tier WAS used" vs "tier SHOULD HAVE been" for training data? Yes, but not blocking v0.2.
- Expose as MCP tool so external agents set tier for their jobs? Likely yes, v0.3.

## Success metrics (post-ship)

- 60%+ of jobs run thrifty
- Average cost per issue drops ≥50% from v0.1 baseline
- Thrifty retry rate ≤15%
- Tier auto-suggestion CSAT > 4/5

## Next steps

1. Accept proposal at v0.2 roadmap discussion
2. Upgrade to full RFC when schema + API shape decided
3. Create tracking issue (see Forge ISS below)
4. Use Phase 2 dev work as calibration dataset
