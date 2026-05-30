# Proposals

Planned features that are not yet implemented. When a proposal ships, its doc moves to [../modules/](../modules/) (if a new feature) or gets absorbed into an existing module doc.

## Current proposals

| Proposal | Status | Target |
|----------|--------|--------|
| [cost-aware-model-routing.md](cost-aware-model-routing.md) | Draft | v0.2 (manual hint) → v0.3 (auto-classify) → v1.0 (budget) |
| [pipeline-prompt-ssot.md](pipeline-prompt-ssot.md) | Draft | One prompt builder + per-state systemPrompt/model/tools/mcp surfaced from project settings + session groups |
| [pipeline-wave-2.md](pipeline-wave-2.md) | Draft | Prompt observability + cost analytics + budgets + Phase 2 optimizations |
| [integration-framework.md](integration-framework.md) | Draft | One polymorphic framework for Coolify (deploy) + Sentry (errors) + Human-Task (PM tool) external integrations |
| [step-handoff-memory.md](step-handoff-memory.md) | Draft | In-session compaction → memory store; replace raw description/plan injection across pipeline states |
| [forge-runner-cli.md](forge-runner-cli.md) | Draft | Thay `packages/dev` (Tauri) bằng CLI daemon thuần Rust — broker core↔runner, lib tách riêng cho đa-runner |
| [web-v2-redesign.md](web-v2-redesign.md) | Draft | Parallel `packages/web-v2`: brand reskin (light/flame), IA cleanup (~40→18 surfaces), 2-layer tokens (dark drop-in), UI-switch + big-bang cutover |

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
