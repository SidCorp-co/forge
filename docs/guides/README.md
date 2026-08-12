# Guides

How-to guides for specific developer tasks. Each guide is task-oriented — "how do I do X" — and written for a developer who already has Forge running.

**Not the same thing as the capability-guide index.** These markdown files are contributor-facing docs, checked into the repo. Agents connected to a Forge project have a separate, server-canonical index of how-to-use-Forge guides (test credentials, dependencies, memory, deploy safety, pipeline lifecycle, uploads) fetched live via the `forge_guide` MCP tool or `GET <host>/api/guides/<slug>.md` — no disk sync, no membership required. That registry lives in `packages/core/src/guides/registry.ts`; add a guide there via a normal PR, not here.

## Available guides

| Guide | Covers |
|-------|--------|
| [pipeline-gates.md](pipeline-gates.md) | Configure pipeline stages: Auto / Manual (gate) / Skip per stage, the single `tested` release gate, recommended presets |
| [trunk-based-development.md](trunk-based-development.md) | Branching model, naming, pre-push hook, who ships how (contributors + maintainers; the pipeline has its own docs) |
| [release.md](release.md) | Cutting a release |
| [integrations.md](integrations.md) | Wiring external integrations |
| [what-is-an-issue.md](what-is-an-issue.md) | What counts as an issue at all — the four gates, where a note / question / audit finding goes instead, draft vs open, and the description contract. Mirrors the public `what-is-an-issue` capability guide |
| [forge-affordances.md](forge-affordances.md) | Operating affordances for connected agents — when to use Forge's own tools (`set_dependency`, draft-vs-open, config writes, memory recall) as trigger → tool → red-flag |
| [skill-improve.md](skill-improve.md) | Skill self-evolution loop — enable improvement messages, how the agent evaluates and applies them per-project, how to write new messages for the registry |

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
