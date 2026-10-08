## Working in a Forge-managed repo

If a repo has a `.forge/` directory or an `mcp.json` naming a `forge` server, its issues, pipeline
and durable memory live in Forge, not in the repo. Read this before your first write.

### The one rule that saves the most time
**Recall before you design.** Project memory is NOT loaded into your context automatically —
`forge_memory_search({ projectId, query, topK: 5 })` is a call you have to make. Skipping it is how
agents rediscover settled decisions, or contradict them. Treat every hit as point-in-time: verify it
against live code or git before you rely on it.

### What Forge owns, and the tool for each
| You need | Call |
|---|---|
| Issues, status, tasks | `forge_issues`, `forge_comments` |
| Ordering between issues | `forge_issues.create`/`.update` with `data.relations`, or `forge_project_pm action=set_dependency` (`from` = the blocker; the same token, no paired device; every door that writes an edge needs the project member role or above, and a viewer is refused naming the role it holds) |
| Repo path, branches, preview URLs, test credentials | `forge_projects.get` |
| Pipeline gates | `forge_config` |
| The project's own prose | `forge_knowledge` |
| A decision, learning or convention worth keeping | `forge_memory_write` |
| Deeper per-package detail | `forge_knowledge` (list/get/search) |
| What Forge is and can do, by area | the `what-forge-is` guide |
| How a Forge feature actually works | `forge_guide` — or fetch these same bytes at `/api/guides/<slug>.md` |

### draft vs open — the costly one
`open` auto-triages and immediately spawns a pipeline run, burning a runner slot. `draft` never
dispatches. So:
- Work you want an agent to pick up now → `open`.
- Work for later, or a follow-up you just want recorded → `draft`.
- A note, learning or decision → **not an issue at all**; write it to memory. Nobody browses the
  issue list for notes.

### Red flags
- **prose-deps** — describing an ordering in text instead of setting a `blocks` edge. Only the edge
  gates dispatch; prose gates nothing.
- **open-as-note** / **draft-as-note** — filing a note as an issue.
- **plan-by-hand** — pre-filling `plan` or `acceptanceCriteria` on create. On a staged project
  those are written by the clarify and plan steps, on an autonomous one by the driver's own
  clarifying and planning phases; filling them deletes that work's reason to exist.
- **wholesale-config-clobber** — patching a nested map (`pipelineConfig.states`)
  without reading it first. These are replace-not-merge; send a complete entry.
- **skip-recall** — see above.
- **fix-by-hand-and-forget** — fixing something outside the pipeline and leaving no status move and
  no recorded learning.

### Writing an issue
Fill `title`, `description`, `priority`, `category`. Keep the description a **requirements
contract** — outcome, business rules, invariants, what is out of scope. Not an implementation script
naming files and endpoints: those claims go stale and, in practice, outrank live exploration.