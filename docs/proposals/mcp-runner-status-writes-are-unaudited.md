# `forge_runners` writes `runners.status` without a `runner_events` row

- Status: **open question, raised from ISS-990** — nothing is broken today, and nothing decides it.
- Related: `packages/core/src/mcp/tools/forge-runners.ts` ·
  `packages/core/src/runners/service.ts:setRunnerStatus` ·
  `packages/core/src/runners/runner-events.ts:setRunnerStatus` ·
  `packages/web-v2/src/features/runners/api.ts`

## The two writers

There are two functions of that name. `runners/runner-events.ts:setRunnerStatus` reads the current
status under a row lock, writes the new one, and appends a `runner_events` row when the value
actually changed; `runners/service.ts:setRunnerStatus` is a bare `UPDATE ... RETURNING`. Every REST
surface — the PATCH, `exclude`, `include` — takes the audited one, and ISS-990 put the MCP tool's
new `restore` on it too. `retire` is the one status write left on the bare writer.

So a box withdrawn from the Runners screen leaves a timeline entry an operator can read, and the
same box withdrawn by an agent over MCP leaves none — while putting it back, by either route, now
does. The Activity panel that answers *why is this runner off* is `runner_events`, and the one
writer that still misses it is the one that turns a runner off.

The annotation on `packages/web-v2/src/features/runners/api.ts` states the rule as already true —
*"`runners.status` is writable ONLY here: this route hands it to `setRunnerStatus`, which audits the
transition"* — which is what makes this worth writing down rather than leaving as taste. Either the
claim is right and the MCP tool is the exception to close, or the claim over-reaches and should be
narrowed to the surfaces it actually covers.

## Why ISS-990 did not settle it

ISS-990 added `restore` beside `retire` and put its own new write on the audited writer, paying the
read-back that costs. It did not move `retire`: that is a working path the issue did not open, and
changing it alters what an existing caller gets back rather than what a new one does. The asymmetry
is deliberate and recorded here rather than left for a reader to discover — but it is an asymmetry,
and it is the one that matters, because withdrawing a box is the action an operator later asks
about.

## What would decide it

Whether `runner_events` is meant to be the complete record of who moved a runner and why, or only
the record of what the web surfaces did. The first reading makes this a defect; the second makes
the `api.ts` annotation the thing to correct.

## A second reader with the same shape

`runners/select.ts:readDeviceClaudeCodeCapabilities` takes a device id alone and reads one
`claude-code` runner row with an unordered `limit(1)`. Its header claimed an index
`runners_device_type_uq` pinned at most one such row per device; no index of that name exists, and
the real one permits a row per project. So on a device bound to two projects the function returns
whichever row Postgres hands back first, and `capabilities.pm` — the PM opt-in — is read from an
arbitrary project's runner.

ISS-990 corrected the false claim to a invariant that says what is actually true. What it did not
decide is what a device-only caller should mean: the union of the device's runners, the row for a
project the caller has not named, or a signature that takes the project too. That is the same
question as above wearing different clothes — whether a per-device fact is really a per-binding one.

## Honest costs

What adopting either fix takes from whoever adopts it — not what the gap costs today.

| Cost | Who pays it |
|---|---|
| `retire` stops returning the row its writer hands back: the audited writer answers with a transition, so the handler needs a read-back and a second round trip per call | every caller of `forge_runners retire`, and that handler's tests, which mock a bare `update` today and would mock a transaction |
| `runner_events` grows a row per agent-driven status write, on a table the Activity panel paginates and nothing prunes | the operator reading a timeline that now mixes their own actions with every automated one, and whoever later writes the retention rule |
| Giving `readDeviceClaudeCodeCapabilities` a project parameter changes a signature used by callers that genuinely hold only a device id | those callers, each of which must find a project to name or justify reading across all of them |
| Deciding the device-only question the other way — a union across the device's runners — makes `capabilities.pm` a fact with no single owner | whoever debugs a box whose PM opt-in is true on one project and false on another |
| Both fixes are invisible to users and buy no behaviour they can see | the reviewer's time, against work that changes what somebody can do |
