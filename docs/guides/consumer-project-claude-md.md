# Consumer-project CLAUDE.md snippet

A thin orientation block to paste at the **top** of the `CLAUDE.md` of any repo
managed by Forge (the projects Forge runs pipelines / agents against — *not*
this monorepo). It gives a Claude Code session opened in that repo just enough
to use Forge well, without duplicating the playbook.

## Why thin

A session running in a Forge-managed repo auto-loads two things: the repo's
`CLAUDE.md`, and the **instructions of any connected MCP server**. The Forge MCP
server now ships a generic *how to use Forge* primer in its `instructions`
field (`packages/core/src/mcp/instructions.ts`) — auto-loaded, always-latest,
zero per-project maintenance. So this file only needs to carry what the MCP
instructions can't: **this project's identity** (projectId / slug) and the
recall-first rule keyed to it.

Do **not** copy the full Forge playbook here — it will drift. Usage guidance
lives in the live `forge-skills` MCP prompt + the MCP server instructions.

> Forge does **not** auto-write this into consumer repos (that would clobber a
> hand-written `CLAUDE.md`, the same failure mode we fixed for `.mcp.json`).
> Paste it yourself, fill the three placeholders, keep it at the top.

## Snippet

```markdown
# <Project Name> — Forge-managed

This repo is managed by **Forge** (control plane for issues, pipeline, and
durable memory). The Forge MCP server is wired in `.mcp.json`; its instructions
explain the tools. This file only carries this project's identity + the
recall-first rule.

- **projectId:** `<uuid>`  ·  **slug:** `<slug>`
- **Recall memory FIRST** — project memory is NOT auto-loaded. Before any task
  that needs project context:
  `forge_memory_search({ projectId: '<uuid>', query: <topic>, topK: 5 })`
  Treat hits as point-in-time — verify against live code/git.
- Codebase orientation: `forge_config` action `get_knowledge` before broad search.
- Issues / status / deps: `forge_issues`, `forge_comments`, `forge_pm_*`.

> Keep this block thin. Forge *usage* guidance lives in the live `forge-skills`
> MCP prompt + the forge MCP server instructions — do not duplicate it here.
```

Find a project's `projectId` / `slug` via `forge_projects.list`, or the project
settings page in the Forge web UI.
