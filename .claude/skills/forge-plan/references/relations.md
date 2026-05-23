# Relations (Step 4.5 — handle only if implementation depends on them) — forge-plan

Issue dependencies live in the `issue_dependencies` table with `kind`:

| Kind | Pipeline behavior | When relevant to plan |
|---|---|---|
| `blocks` | L2 dispatcher gate — blocker must reach `released`/`closed`/`pipeline_failed` before this issue dispatches | Note ordering in plan if this issue depends on another shipping first |
| `decomposes` | Decomposition lifecycle (cascade approve, watcher, atomic release) — see [decomposition.md](decomposition.md) | Only when planning the parent epic |
| `relates`, `duplicates`, `parent` | PM/UX metadata only — no pipeline action | Skip unless it's actually a hard dependency (then use `blocks`) |

## When to include a `## Relations` section in the plan

Only when dependencies affect implementation:

- **Shared types / API contracts** — the other issue changes a type this plan consumes; coordinate ordering.
- **Ordering required** — another issue MUST land first (verify it's a `blocks` edge, not `relates`).
- **Duplicate / superseded** — mark `duplicates` and stop planning; link to the canonical issue.

Skip the section for `relates` links that are just context — don't pad the plan with traceability-only relations.

## Format

```markdown
## Relations
- **blocks ISS-xxx** (<title>) — <why it blocks and what lands first>
- **duplicates ISS-yyy** — <link to canonical>
```

One line per relation, consequence spelled out.

## Adding a dependency (only if the plan reveals a new ordering constraint not already captured)

Use the MCP tool, NOT a REST endpoint (plan agents have no HTTP fetch):

```
forge_pm_set_dependency → {
  projectId: "<projectId>",
  fromIssueId: "<blocker>",    // must reach released/closed/pipeline_failed first
  toIssueId:   "<blocked>",    // waits at L2 with failure_reason='waiting_on_dep'
  kind: "blocks"
}
```

`projectId` comes from `forge_config → get → response.project.id` already fetched in Step 1. The tool is idempotent on `(projectId, fromIssueId, toIssueId, kind)` — duplicate calls return `{ id, created: false }`.

For `decomposes`, use the workflow in [decomposition.md](decomposition.md) — children + parent atomically.
