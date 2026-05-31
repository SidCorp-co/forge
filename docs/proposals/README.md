# Proposals

Planned features that are not yet implemented. When a proposal ships, its doc moves to [../modules/](../modules/) (if a new feature) or gets absorbed into an existing module doc.

## Current proposals

| Proposal | Status | Target |
|----------|--------|--------|
| [cost-aware-model-routing.md](cost-aware-model-routing.md) | Draft | v0.2 (manual hint) → v0.3 (auto-classify) → v1.0 (budget) |
| [web-v2-redesign.md](web-v2-redesign.md) | In progress | Parallel `packages/web-v2`: brand reskin (light/flame), IA cleanup (~40→18 surfaces), 2-layer tokens (dark drop-in), UI-switch + big-bang cutover |

> Shipped proposals moved to system docs: step-handoff → [../modules/memory-knowledge/step-handoffs.md](../modules/memory-knowledge/step-handoffs.md); runner daemon → [../architecture/runner-daemon.md](../architecture/runner-daemon.md); integration framework → [../integrations/framework.md](../integrations/framework.md); prompt config → [../modules/agents-jobs/prompt-config.md](../modules/agents-jobs/prompt-config.md).

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
