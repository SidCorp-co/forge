# `forge_project_pm` dispatch and write_decision have no route left

**Filed by ISS-931, which created the condition. Not a defect report — a decision nobody has
taken.**

`assertPmActor` needs a `runners` row with `capabilities.pm = true`, keyed on a paired device's id.
`ISS-931` took the device off `/mcp`, so the two actions that call it refuse every caller the
transport can produce, by name. Neither has a REST twin: `pm/read-routes.ts` covers
`snapshot`/`graph`/`runner-load`, and `pm/routes.ts` covers PM config, policies, decision READS and
the escalation respond. There is no route that writes a PM decision or enqueues a PM job.

What that costs, measured on the whole `mcp_audit_log` on 2026-09-06:

| action | device calls, lifetime | last device call |
|---|---|---|
| `forge_project_pm action=dispatch` | 4 | 2026-08-06 |
| `forge_pm_dispatch` (retired shim) | 15 | 2026-06-07 |
| `forge_project_pm action=write_decision` | 1 | 2026-08-08 |

So this labels a dead path rather than removing a live capability — and `dispatch` was already
dead for a second, older reason: `dispatchPmJob` has thrown unconditionally since `ISS-895`
removed the staged lane, because the job types it could enqueue have no lane to run in. That
refusal is the one a caller reads, deliberately ahead of the credential one.

`write_decision` is the real residual. `writePmDecision` (`pm/decisions-service.ts`) is live code
— it inserts a decision, queues the memory indexer, and can raise an escalation notification — and
it now has no caller. Its behaviour is still asserted directly, in
`mcp/tools/forge-pm-write-decision.test.ts`.

Three ways out, none of them ISS-931's to pick:

1. **Give it a REST route.** `POST /api/projects/:projectId/pm/decisions` behind `requireAuth`,
   authorised on project role. The PM agent then writes decisions on its `session:` PAT like
   everything else, and `capabilities.pm` stops being an authorisation input.
2. **Keep the capability, move the gate.** Bind `capabilities.pm` to something a token can carry —
   a PAT scope, or a runner id on the session — so the flag still means "this box is the PM agent"
   without a device token being the way to prove it.
3. **Delete the actions and the service.** If no PM agent is coming back, `write_decision`,
   `dispatch`, `assertPmActor`, `dispatch-service.ts` and `decisions-service.ts`'s write half all
   go, and `pm_decisions` becomes a read-only historical table. This is the largest change and the
   only one that leaves nothing to explain.

## Honest costs

The price of each way out, for whoever adopts it — not of the residual it closes.

| Option | What it takes |
|---|---|
| 1 — REST route | A new write route on `pm/routes.ts` and its authz, plus tests: the first PM write reachable by anyone with a project write role, where today it needs a flag an operator sets per box. Project role becomes the only fence on a decision that feeds the memory index and can raise an escalation notification. |
| 2 — move the gate | Redefines what `capabilities.pm` means and touches every reader of it: a new PAT scope (a `pat_tokens` shape change and a mint path) or a runner id on `agent_sessions`. Costs a migration and leaves the capability model with two spellings during it. |
| 3 — delete both | Throws away `writePmDecision`, `dispatch-service.ts` and the escalation-notification path — the largest diff of the three, and unrecoverable if a PM agent returns: `pm_decisions` keeps its history but nothing can add to it. |
| Doing nothing | Two enum actions on a live tool that refuse every caller, and ~90 lines of service code with no caller, both of which every future reader of `forge_project_pm` has to be told about. This file is that telling, and it is a cost that recurs. |

Whoever takes one of these rewrites the `forge_project_pm` row in
[`../architecture/data-plane-surface.md`](../architecture/data-plane-surface.md) and the
`assertPmActor` guard in `mcp/tools/project-authz.ts` in the same commit, and deletes this file.
