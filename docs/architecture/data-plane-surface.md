# The data plane: which MCP tool, which REST route

**Most MCP tools that read or write data have a REST twin the CLI reaches.** This table is what an
agent or a skill author calls instead. Six tools stay on MCP by design, three sit behind a fence
that is deliberate and permanent, two are open questions, and one has no route at all.

Verified 2026-09-01 against `registered-tools.ts`, the mounts in `index.ts`, and
`PAT_ALLOWED_PREFIXES` in `middleware/pat-rest-surface.ts`. Where a route is listed, it was checked
to call the same service as the tool — not merely to carry a similar name.

```mermaid
flowchart LR
  A[agent in a job] -->|"$FORGE_PAT"| CLI["forge-runner api"]
  A -->|"session hooks only"| MCP["/mcp · 6 tools"]
  CLI --> F{"PAT allowlist<br/>16 prefixes"}
  F -->|on it| R["REST · the data plane"]
  F -->|not on it| X["403 PAT_NOT_PERMITTED"]
  MCP --> R
```

The fence is an allowlist, not a deny-list: **a new REST route is 403 to every PAT until its prefix
is added.** That is deliberate — a forgotten entry costs a caller an error they report, where a
forgotten deny-list entry is a silent leak nobody reports.

**The allowlist only governs routes that authenticate.** A router mounted with no auth middleware
never reaches `beginPatRequest`, so the fence never runs and the prefix is irrelevant — `/api/guides`
is the live example. Read the mount and its middleware, not the prefix alone.

## Reachable from the CLI today

| MCP tool | REST | 
|---|---|
| `forge_issues` | `/api/issues`, `/api/projects/:id/issues` |
| `forge_issues` mark_merged / unmark | `POST` / `DELETE /api/issues/:id/merge` |
| `forge_comments` | `/api/comments` |
| `forge_memory.*` (5) | `/api/memory` |
| `forge_knowledge` | `/api/knowledge`, `/api/knowledge-edges`, `/api/projects/:id/knowledge` |
| `forge_config` | `/api/projects/:id/pipeline-config` |
| `forge_skills.*` (11) | `/api/skills`, `/api/projects/:projectId/skills` |
| `forge_skill_facts.*` (2) | `/api/skill-facts` |
| `forge_jobs.*` (5) | `/api/jobs`, `/api/projects/:id/jobs` |
| `forge_pipeline_runs.get` | `/api/pipeline-runs` |
| `forge_project_pipeline_runs` | `/api/projects/:id/pipeline-runs` |
| `forge_projects.*` (4) | `/api/projects`, `/api/projects/:id` |
| `forge_project_pm`, `forge_pm.set_dependency` | `/api/projects/:projectId/pm` |
| `forge_coolify_deploy` | `/api/projects/:projectId/integrations/coolify[/status\|/deploy]` |
| `forge_metrics.*` (4) | `/api/projects/:id/metrics` |
| `forge_agent_sessions.*` (2) | `/api/projects/:id/agent-sessions` |
| `forge_reconcile` | `/api/projects/:projectId/reconcile-runs` |
| `forge_ux_findings` | `/api/projects/:id/ux-findings` |
| `forge_schedules` | `/api/schedules` |
| `forge_health` | `/health` (public), `/api/projects/health` |
| `forge_guide` | `/api/guides`, `/api/guides/:slug` — unauthenticated by design, so the fence does not apply |

Two fields were MCP-only until 2026-09-01 and are now on `PATCH /api/issues/:id`:
`sessionContext` and `detectorKey`. `sessionContext.branch` is the direct-ship marker
`pipeline/work-evidence.ts` reads as proof that work exists, so an agent that cannot write it
cannot satisfy the evidence gate on `developed`, `testing` or a merge claim.

## Staying on MCP

| Tool | Why it cannot move |
|---|---|
| `forge_uploads` | returns an **image content block** to a multimodal model; a shell process cannot |
| `forge_step_start` · `forge_phase` | session lifecycle hooks, not data queries |
| `forge_step_handoff.write` / `.get` / `.delete` | same — the handoff is session state |

## Fenced on purpose — do not "fix" these by adding a prefix

`PAT_ALLOWED_PREFIXES` names four prefixes as the ones *"where being wrong once ends the fence for
good"*: `/api/pat`, `/api/orgs`, `/api/admin`, `/api/me`. None of them resolves a project, so a
project-scoped token there is an account-scoped credential wearing a project-scoped label.

| Tool | REST route | Why it stays out |
|---|---|---|
| `forge_orgs.list` · `forge_orgs.members` | `/api/orgs` | org-wide by definition; a token bound to one project has no business enumerating the org |
| `forge_collaborators` | `/api/me/collaborators` | `/api/me` is caller-scoped, not project-scoped |
| — | `/api/pat` | a scoped token that can mint an unscoped one has no scope. This is the entry whose absence collapses every other one |

Two more are fenced for the same reason even though their prefix IS allowlisted:

- **`/api/me/ops-health`** fans out across every project the caller can see. The per-project twin
  (`/api/projects/:id/ops-health`) is the one a PAT reaches.
- **`/api/agent-sessions`** (the unscoped list) returns every session of every visible project,
  `messages[]` included. The project-scoped twin under `/api/projects/:id` is the PAT surface.

A caller that genuinely needs one of these uses a session (browser/desktop login), or gets a
project-scoped twin built for it — not a widened fence.

## Open — no PAT route yet, and no decision recorded either way

| Tool | REST route | State |
|---|---|---|
| `forge_runners` | `/api/runners` | fleet-wide, but a project-scoped twin is plausible; nothing decided |
| `forge_feedback` | `/api/feedback-reports` | project-scoped in practice; nothing decided |
| `forge_storefront_target` | — | no REST route exists at all |

## Calling it

```
forge-runner api issues                          # GET  /api/issues
forge-runner api issues/<id>/merge -X POST -d '{"target":"main"}'
forge-runner api projects/<id>/integrations/coolify/deploy -X POST -d '{}'
```

`issues`, `/issues` and `/api/issues` are the same path. The credential is a **personal access
token**, not the device token — a device token answers 401 on every route behind `requireAuth`. In a
job the runner exports one as `$FORGE_PAT`, minted for that job and revoked when it goes terminal.
Full flag and exit-code reference: [`packages/runner/README.md`](../../packages/runner/README.md).
