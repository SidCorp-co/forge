# Proposals

Planned features that are not yet implemented. When a proposal ships, its doc moves to [../modules/](../modules/) (if a new feature) or gets absorbed into an existing module doc.

## Current proposals

| Proposal | Status | Target |
|----------|--------|--------|
| [cost-aware-model-routing.md](cost-aware-model-routing.md) | Draft | v0.2 (manual hint) → v0.3 (auto-classify) → v1.0 (budget) |
| [dispatch-load-balance-v2.md](dispatch-load-balance-v2.md) | Draft (resolved, ready for code) | Serial primary + failover-only standby; config-driven L2 merge gate (mergeStates); replaces ad-hoc selectRunnerForJob logic |
| [core-strapi-decoupling.md](core-strapi-decoupling.md) | Resolved (pending acceptance) | Clean break — no Strapi parity, single flip PR at Phase 2.5 |
| `permission-model-v2.md` (not yet committed) | Draft (candidate for RFC promotion) | Phase 1–2 side-by-side + backfill → Phase 3 cut → Phase 4 cleanup |
| [pipeline-wave-2.md](pipeline-wave-2.md) | Draft | Post-v0.1.34 backlog: prompt observability + cost analytics + budgets + Phase 2 optimizations |

## Naming convention

`proposal-{short-name}.md`. Short, topic-focused.

## How this differs from `rfcs/`

| | `proposals/` | `rfcs/` |
|---|-------------|---------|
| Formality | Sketch, one-page | Full template, FCP |
| Status | Might not ever ship | Decided (accept/postpone/reject) |
| Audience | Maintainer + early contributors | Full community |
| Lifespan | Short — moves to modules/ on ship | Permanent historical record |

Use `proposals/` for "I'm thinking about this, not sure yet." Upgrade to an `rfcs/` RFC when the proposal affects API, architecture, or cross-team surfaces.
