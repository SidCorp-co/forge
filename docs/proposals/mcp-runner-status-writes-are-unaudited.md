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
surface — the PATCH, `exclude`, `include` — takes the audited one. The MCP tool takes the bare one,
for `retire` and, since ISS-990, for its inverse `restore`.

So a box withdrawn from the Runners screen leaves a timeline entry an operator can read, and the
same box withdrawn by an agent over MCP leaves none. The Activity panel that answers *why is this
runner off* is `runner_events`, and half its writers do not reach it.

The annotation on `packages/web-v2/src/features/runners/api.ts` states the rule as already true —
*"`runners.status` is writable ONLY here: this route hands it to `setRunnerStatus`, which audits the
transition"* — which is what makes this worth writing down rather than leaving as taste. Either the
claim is right and the MCP tool is the exception to close, or the claim over-reaches and should be
narrowed to the surfaces it actually covers.

## Why ISS-990 did not settle it

ISS-990 added `restore` beside `retire` and made it match its pair, which is what that issue was
about. Routing either through the audited writer changes `retire`, a working path the issue did not
open, and changes its return shape: the audited writer answers with a transition result rather than
the row, so both handlers would need a read-back before they can return `publicRunnerRow`. That is
a change worth making deliberately, with its own tests, rather than as a side effect of adding an
inverse.

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

ISS-990 corrected the false claim to a `cm:guard` that says what is actually true. What it did not
decide is what a device-only caller should mean: the union of the device's runners, the row for a
project the caller has not named, or a signature that takes the project too. That is the same
question as above wearing different clothes — whether a per-device fact is really a per-binding one.
