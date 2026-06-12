# Proposal: Cost-aware model routing

Route each job to the cheapest model that can complete it at acceptable quality. Today every job uses the project-default model — boilerplate burns premium tokens, and there is no budget cap.

- **Status:** Draft (pre-RFC) · 2026-04-20 · @junixlabs. Schema + cost rollup shipped; routing/UI phases open.
- **Target:** v0.2 (manual hint) → v0.3 (auto-classify) → v1.0 (budget-aware)

## Tiers

| Tier | Examples | Model |
|------|----------|-------|
| **Thrifty** | Boilerplate, scaffolding, config edits, CRUD-following-patterns, docs, test-after-fixture | Haiku 4.5 |
| **Standard** | Integrations with judgment, most forge-code runs, moderate refactors | Sonnet 4.6 |
| **Premium** | Schema design, security-critical code, state-machine semantics, cross-cutting architecture | Opus |

Principles: explicit by default (config names the tier, no surprise spend) · suggested not forced · overridable per job · cost per job/issue/project measurable.

## Phases

| Phase | Ships | Exit criterion |
|---|---|---|
| **v0.2 manual hint** | `modelTier` on job/skill/project (`thrifty\|standard\|premium\|auto`), dispatch resolution job→skill→project→default, tier→model map per provider, tier selector + Kanban badge, cost recording | user marks an issue thrifty and the job runs on Haiku |
| **v0.3 auto-classify** | heuristic (keywords, description length, file types, stage) + optional Haiku classify call; `auto` resolves to suggestion; track override rate | 80% correct auto-tier, <20% override |
| **v1.0 budget** | per-project caps (per tier), dispatcher defers/downgrades near cap, 50/80/100% alerts | "$50/mo premium budget" enforced by dispatcher |

## Mechanism sketch

```ts
// jobs: modelTier (enum, default 'standard'), modelResolved, tokensInput/Output, costEstimatedUsd
// skills + projects: defaultModelTier; projects.monthlyBudgetUsd (v1.0)

resolveModelTier(job, skill, project)   // job → skill → project → 'standard'
resolveModel(tier, provider)            // MODEL_MAP[provider][tier]; per-project override allowed
// { anthropic: { thrifty: 'claude-haiku-4-5', standard: 'claude-sonnet-4-6', premium: 'claude-opus-…' }, … }
```

Known risk: thrifty-fail → standard-retry is near break-even only if retry rate <15% — record and tune.

## Open questions

- MCP tool so external agents set tier (likely v0.3)?
- Record "tier used" vs "tier should have been" for classifier training (yes, post-v0.2)?

## Success metrics

60%+ jobs thrifty · cost/issue −50% vs v0.1 baseline · thrifty retry ≤15%.
