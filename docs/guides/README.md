# Guides

How-to guides for specific developer tasks. Each guide is task-oriented — "how do I do X" — and written for a developer who already has Jarvis Agents running.

## Available guides

_(None yet. The Diátaxis quickstart lives at [../quickstart.md](../quickstart.md); deeper how-tos get added here as patterns stabilize in v0.2+.)_

## Planned guides (v0.1 → v0.2)

| Guide | Status | Audience |
|-------|--------|----------|
| Pair a device | Planned | First-time users — overlaps with quickstart, expanded detail |
| Author a custom skill | Planned | Users who want to extend pipeline with domain-specific agents |
| Integrate a webhook source (GitHub, Sentry, custom) | Planned | Self-hosters connecting external event sources |
| Set up a CI runner as a device | Planned | Teams running jobs on headless boxes |
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
