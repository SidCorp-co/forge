# Where a runner's status came from

`runner_events` is the audit of `runners.status`, and it answers for the decisions rather than for
the column. Every operator act writes one — `runners/routes.ts` for the PATCH, the exclude and the
include, `runners/ghost-reaper.ts` for the days-absent sweep, and
`mcp/tools/forge-runners.ts` for retire and restore, all through
`runners/runner-events.ts:setRunnerStatus`.

`runners/heartbeat-ws.ts` does not. It sets `online` on a register retry and `offline` on
disconnect with a direct `update`, so a box that drops and comes back leaves no row.

## What that cost, measured

ISS-1127 shipped a release blocker naming, per box, why it could not be handed work. Its clause for
a box at `draining` or `disabled` read *"has been taken out of the pool by an operator"*, inferred
from the status column alone. An independent judging run read `sid-xeon-1` at production carrying
`disabled` with no `runner_events` row after 2026-09-20T17:35Z, whose reason was `mcp_restore`.
Whatever wrote `disabled` left no trace, and the sentence told the operator an operator had done it.

Two halves of that are closed. The MCP retire path wrote the column through the UNAUDITED setter
while restore, one action below it in the same file, used the audited one — both now audit under
`mcp_retire`, and the unaudited `runners/service.ts:setRunnerStatus` is deleted so the pair cannot
come back. The clause now names the status it read rather than who set it.

## The residual, and why it is not taken here

Auditing the heartbeat's own writes is not a wording question. `online` and `offline` are written on
every register retry and every disconnect, so the row volume is the fleet's reconnect rate rather
than its operator's, and `runner_events` would stop being a short list somebody reads. Whether that
is worth having — a retention window, a separate table, or a decision that machine transitions are
`last_seen_at`'s job and not this table's — belongs to whoever owns the Runners surface, not to a
release sentence.

Until it is decided, `runner_events` answers *what was decided about this runner*, the comment on
`runnerEvents` in `db/schema.ts` says so, and no reader may infer an actor from `runners.status`.

## Honest costs

- **`runner_events` answers a narrower question than its name suggests.** A reader wanting "what has
  this box's status done" has to consult `last_seen_at` and the heartbeat's own logs as well, and
  nothing in the row set says which of the two it is looking at.
- **No surface can attribute a `draining` or `disabled` box to an actor until this is decided**, so
  the release blocker, the Runners tab and any future audit view each have to name the status they
  read rather than the person who set it — which reads as vaguer than the truth they could give if
  the heartbeat wrote rows.
- **Deciding it later costs more than deciding it now.** Every screen written against the narrow
  reading has to be revisited if machine transitions start landing in the table, and a retention
  window added afterwards is a migration over rows people have already started citing.
