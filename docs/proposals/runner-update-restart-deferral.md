# Auto-update stages the new binary, then never restarts into it

**Status:** open decision — measured, no code proposed. Reversing the bound is a fleet-wide
behaviour change and a human's call.

A runner with `update.auto = true` can sit on a superseded binary indefinitely while reporting
healthy. Measured on `dev1 · CLI runner` (device `0629f109`) 2026-09-01: **25 hours behind, across
three consecutive update cycles**, with the replacement binary already on disk the whole time.

## What was measured

The daemon writes the new binary immediately, then tries to drain to idle before exiting. The drain
is bounded at `DRAIN_TIMEOUT_SECS` (30 min). Three cycles in a row lost that race:

| Time (+07) | Log line |
|---|---|
| Sep 01 01:11 | `[update] applied 0.9.2 → 0.9.4 — draining before restart` |
| Sep 01 01:41 | `[update] still busy (1 in-flight) after 1800s — deferring restart to the next idle window` |
| Sep 01 07:11 | `[update] applied 0.9.2 → 0.9.5 — draining before restart` |
| Sep 01 07:41 | `[update] still busy (1 in-flight) after 1800s — deferring restart` |
| Sep 01 13:11 | `[update] applied 0.9.2 → 0.9.6 — draining before restart` |
| Sep 01 13:41 | `[update] still busy (1 in-flight) after 1800s — deferring restart` |

The process state confirms the swap happened and was never entered:

```
PID 591968  started Mon Aug 31 13:10:39  elapsed 1-04:55
/proc/591968/exe -> /home/kieutrung/.local/bin/forge-runner (deleted)
$ forge-runner --version        # the file on disk
forge-runner 0.9.7
```

`(deleted)` is the whole finding: the running process holds the old inode while the path it was
launched from now carries 0.9.7. Core reads `agent_version` from the running build, so the fleet
view shows `0.9.2` — accurate, and indistinguishable from a box whose update never downloaded.

## Why it does not recover

`DRAIN_TIMEOUT_SECS`'s own doc comment names two recovery paths: *"giving up this cycle just defers
the restart to the next idle window or the next 6h tick."* **Only the second exists.** In
`daemon/mod.rs`, a `drain_to_idle` that returns `false` falls through to `tick.tick()`; nothing
watches for the next idle moment, and no pending-restart state survives the cycle. The 6h tick then
re-enters the same branch — `CURRENT_VERSION` is compiled into the running build, so it stays
`0.9.2` and every manifest still reads newer — re-applies, and restarts the same bounded race.

The box does reach idle, and often. `[claude] idle past the session ceiling — closing` appears eight
times in the same 25 hours. It simply never lands inside a 30-minute window that opens on a 6-hour
schedule. A box that holds sessions at all is therefore *more* likely to be stuck the busier it is,
which inverts what an operator would guess.

## The decision

**Keep the bound.** A busy box stays on its old build until it happens to be idle when the window
opens. Auto-update is then best-effort for exactly the runners that matter most, and the version
column is honest about the running build but silent about the staged one.

**Or make the restart pending.** Once `apply()` has swapped the binary, hold that intent and exit at
the next moment in-flight reaches zero, with no deadline. The daemon would have converged within
hours here rather than not at all.

Whoever decides should also say whether a staged-but-not-entered update deserves its own signal.
Today the two states — "never downloaded" and "downloaded, running the old inode for a day" — are
one number on the dashboard, and only the second is a defect.

## Not the cause of the 2026-09-01 tool-deletion incident

Worth stating because the same box is in both traces. The `forge_skill_facts.get` → `not_found` at
09:07 was a deleted MCP tool, not a stale runner: the caller's credential class was what broke, and
every runner version calls that tool the same way. The version lag is a separate defect that this
box happened to be carrying at the time.

## Honest costs

Prices the fix (the pending-restart option), not the bug.

| Cost | Detail |
|---|---|
| Restarts become unpredictable | Today a bounce can only happen in a known 30-minute window after a poll; with a pending restart it happens at whatever second the last job ends, which is when an operator is least expecting it |
| A parked session is closed by a restart nobody scheduled | `close_parked_sessions` runs on the way out, so a resident session gets its checkpoint budget and dies at an arbitrary idle moment rather than inside the known window |
| New cross-cycle state that has to be right | A pending-restart flag that fails to clear turns every idle moment into an exit, which on a quiet box is a restart loop — and the failure mode is a runner that looks like it is flapping, not one that looks stuck |
| Does not stop the wasted re-download | The 6h tick still re-`apply`s while a restart is pending unless that is fixed in the same change; three redundant downloads happened here |
| Leaves the dashboard ambiguous either way | Neither option distinguishes "never downloaded" from "staged, not entered" without a second field, which is additional work in core and in the runner's heartbeat |
