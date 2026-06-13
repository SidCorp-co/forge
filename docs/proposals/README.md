# Proposals

Planned features that are not yet implemented. When a proposal ships, its doc moves to [../modules/](../modules/) (if a new feature) or gets absorbed into an existing module doc.

## Current proposals

| Proposal | Status | Target |
|----------|--------|--------|
| [cost-aware-model-routing.md](cost-aware-model-routing.md) | Draft (schema + cost rollup shipped; UI/routing phases open) | v0.2 (manual hint) → v0.3 (auto-classify) → v1.0 (budget) |

> Shipped proposals are **deleted** (git history is the design record); their live docs: memory v2 → [modules/memory-knowledge](../modules/memory-knowledge/README.md) · web-v2 redesign/parity (ISS-397) → web-v2 is simply the canonical UI · step-handoff → [../modules/memory-knowledge/step-handoffs.md](../modules/memory-knowledge/step-handoffs.md) · runner daemon → [../architecture/runner-daemon.md](../architecture/runner-daemon.md) · integration framework → [../integrations/framework.md](../integrations/framework.md) · prompt config → [../modules/agents-jobs/prompt-config.md](../modules/agents-jobs/prompt-config.md) · skill facts → [../modules/agents-jobs/skill-facts.md](../modules/agents-jobs/skill-facts.md).

## Naming convention

`<topic>.md` — short, kebab-case, topic-focused (e.g. `cost-aware-model-routing.md`). No `proposal-` prefix; the directory already says "proposal."

This is also the home for **no-code pipeline deliverables**: when an issue's only output is a decision/audit/spike, the pipeline materializes it here as `docs/proposals/<topic>.md` so it becomes a mergeable, reviewable artifact (see the forge-plan / forge-code skills).

## How this differs from `rfcs/`

| | `proposals/` | `rfcs/` |
|---|-------------|---------|
| Formality | Sketch, one-page | Full template, FCP |
| Status | Might not ever ship | Decided (accept/postpone/reject) |
| Audience | Maintainer + early contributors | Full community |
| Lifespan | Short — moves to modules/ on ship | Permanent historical record |

Use `proposals/` for "I'm thinking about this, not sure yet." Upgrade to an `rfcs/` RFC when the proposal affects API, architecture, or cross-team surfaces.
