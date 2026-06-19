# Guides

How-to guides for specific developer tasks. Each guide is task-oriented — "how do I do X" — and written for a developer who already has Forge running.

## Available guides

| Guide | Covers |
|-------|--------|
| [pipeline-gates.md](pipeline-gates.md) | Configure pipeline stages: Auto / Manual (gate) / Skip per stage, the single `tested` release gate, recommended presets |
| [trunk-based-development.md](trunk-based-development.md) | Branching model, naming, pre-push hook, who ships how (contributors + maintainers; the pipeline has its own docs) |
| [release.md](release.md) | Cutting a release |
| [integrations.md](integrations.md) | Wiring external integrations |

The Diátaxis quickstart lives at [../quickstart.md](../quickstart.md).

## Planned guides (v0.1 → v0.2)

| Guide | Status | Audience |
|-------|--------|----------|
| Author a custom skill | Planned | Users who want to extend pipeline with domain-specific agents |
| Integrate a webhook source (GitHub, Sentry, custom) | Planned | Self-hosters connecting external event sources |
| Migrate from the agent-session model (pre-v0.1) | Planned | Early adopters upgrading |
| Backup and restore Postgres (incl. `pgvector` embeddings) | Planned | Operators |
| Debug a failing job | Planned | Anyone hitting a stuck job |

## How to add a guide

1. Task-first title — start with the verb: "Author a custom skill", not "Custom skills"
2. Prerequisites block at the top (what the reader already needs)
3. Numbered steps, copy-pasteable commands
4. "Verify it worked" section
5. "Troubleshooting" for common failure modes
6. Link to reference material in modules/ or decisions/, don't restate

File naming: `kebab-case-task-name.md`.
