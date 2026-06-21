# Consumer-project Forge orientation

How a Claude Code session opened in a Forge-managed repo (a project Forge runs
pipelines / agents against — *not* this monorepo) learns to use Forge well.

## What a session auto-loads

A session running in a Forge-managed repo auto-loads three things:

1. **The Forge MCP server `instructions`** — a generic *how to use Forge* primer
   (`packages/core/src/mcp/instructions.ts`), surfaced to any session connected
   to Forge MCP. Always-latest, zero per-project maintenance.
2. **`.forge/orientation.md`** — this project's specifics (projectId, slug, the
   recall-first rule). Imported into `CLAUDE.md` via `@.forge/orientation.md`.
3. **`CLAUDE.md`** — the repo's own file, which carries the fixed import pointer.

## Auto-seeded on device provision

The runner seeds the orientation during workspace provisioning (the
`writing_mcp` step; see `packages/runner/.../workspace/orientation.rs`):

- **`.forge/orientation.md`** — Forge owns this file and fully overwrites it on
  every provision. Its content is **deterministic** for a project (projectId +
  slug + fixed pointers), so re-provisioning rewrites identical bytes and leaves
  the git tree clean. It is **not** git-excluded (no secret) — commit it so the
  whole team and every device share it.
- **`CLAUDE.md`** — provisioning prepends ONE fixed, marker-delimited block
  (`<!-- forge:orientation -->` … `@.forge/orientation.md`) **only if the marker
  is absent**. It never rewrites the rest of the file, never auto-commits, and
  never git-excludes — a human commits the one-time diff. If the marker is
  already present, the file is left untouched (idempotent).

This split keeps the volatile content in a Forge-owned file while CLAUDE.md only
ever receives a small, fixed pointer — so Forge can never clobber a project's
hand-written CLAUDE.md (the failure mode we fixed for `.mcp.json`).

## Manual paste (no device runner, or before first provision)

For a repo with no device-bound runner — or to set it up before the first
provision — paste this block at the **top** of `CLAUDE.md` yourself and fill the
two placeholders (the orientation can also live inline instead of in
`.forge/orientation.md`):

```markdown
# <Project Name> — Forge-managed

This repo is managed by **Forge** (control plane for issues, pipeline, and
durable memory). The Forge MCP server is wired in `.mcp.json`; its instructions
explain the tools.

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
