# Proposals

Planned features that are not yet implemented. When a proposal ships, its doc moves to [../modules/](../modules/) (if a new feature) or gets absorbed into an existing module doc.

## Current proposals

| Proposal | Status | Target |
|----------|--------|--------|
| [cost-aware-model-routing.md](cost-aware-model-routing.md) | Draft (schema + cost rollup shipped; UI/routing phases open) | v0.2 (manual hint) → v0.3 (auto-classify) → v1.0 (budget) |
| [memory-v2-cognitive-layer.md](memory-v2-cognitive-layer.md) | SHIPPED 2026-06-10 (PR #175, phases 0–4) | Remaining: graph retrieval, global scope (phase 5). Live doc: [modules/memory-knowledge](../modules/memory-knowledge/README.md) |
| [web-v2-redesign.md](web-v2-redesign.md) | SHIPPED 2026-06-07 (ISS-397) | v2 canonical at root `/`; v1 retired. Kept as design record |
| [web-v2-v1-retirement-parity.md](web-v2-v1-retirement-parity.md) | Executed 2026-06-07 (ISS-397) | Historical record of the parity audit |

> Shipped proposals moved to system docs: step-handoff → [../modules/memory-knowledge/step-handoffs.md](../modules/memory-knowledge/step-handoffs.md); runner daemon → [../architecture/runner-daemon.md](../architecture/runner-daemon.md); integration framework → [../integrations/framework.md](../integrations/framework.md); prompt config → [../modules/agents-jobs/prompt-config.md](../modules/agents-jobs/prompt-config.md); skill facts → [../modules/agents-jobs/skill-facts.md](../modules/agents-jobs/skill-facts.md).

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
