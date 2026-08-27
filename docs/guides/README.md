# Guides

Task-oriented how-tos for a developer who already has Forge running.

**Not the capability-guide index.** These files are contributor-facing and checked into the repo.
Agents connected to a Forge project read a separate, server-canonical guide registry
(`packages/core/src/guides/registry.ts`) live via the `forge_guide` MCP tool or
`GET <host>/api/guides/<slug>.md` — no disk sync, no membership. Add a guide there via a normal PR,
not here.

| Guide | Covers |
|-------|--------|
| [trunk-based-development.md](trunk-based-development.md) | Branching model, naming, pre-push hook, who ships how |
| [release.md](release.md) | Cutting a release |
| [what-is-an-issue.md](what-is-an-issue.md) | The four admission gates; where a note / question / audit finding goes instead. Mirrors the public `what-is-an-issue` capability guide |
| [forge-affordances.md](forge-affordances.md) | Trigger → tool → red-flag for connected agents (`set_dependency`, draft-vs-open, config writes, memory recall) |

First run: [../quickstart.md](../quickstart.md). Pipeline stages, gates and the status ladder:
[../modules/issues-pipeline/status-pipeline.md](../modules/issues-pipeline/status-pipeline.md).

Naming: `kebab-case-task-name.md`, verb-first title, prerequisites at the top, copy-pasteable
commands, a "verify it worked" step. Link to `modules/` for reference material instead of
restating it.
