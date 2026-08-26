# A UI stage pays for the browser crashing, by hand, every time

**Status:** open residual, recorded 2026-08-26. Carved out of ISS-862, which shipped the other three
bullets of its issue (no-ack quarantine, honest kill-ack, the alarm). Not fixed by it.

## The measurement

anhome, 14-day window ending 2026-06-22:

| Stage | p50 | p95 | Ratio |
|---|---|---|---|
| clarify | 155s | 524s | **3.38×** |
| test | — | 790s | — |

`clarify` was the only stage in that window breaching a 3× p50→p95 threshold, and `clarify` and
`test` are exactly the two browser-driven stages. The tail is the browser dying mid-session and the
recovery being paid by a person.

## What is already paid for

The wedge half is partly covered. `runner/process.rs` sets `MCP_TOOL_TIMEOUT` on every agent
command, so a hung MCP server cannot wedge a job forever, and `runner/claude_code.rs` raises
`MCP_TIMEOUT` to 15s because `chrome-devtools-mcp` and `playwright` launched via `npx` routinely
need more than the CLI default to connect. Both are bounds on *hanging*.

Neither is a bound on *crashing*. A browser that dies takes the agent's session state with it, and
nothing brings one back.

## Why it is recorded rather than fixed

Its evidence is a p95 on another project from June, with no specimen reachable from the session that
would have fixed it: nothing here crashes a browser on demand, and a fix chosen without watching one
fail is a guess wearing a diff. The other three bullets of ISS-862 were reproducible by reading the
code and are shipped.

It also sits on a different axis from the rest of that issue. Runner health is core's dispatch
bookkeeping; this is the runner's MCP process management, one package over.

## What closing it looks like

Two shapes, and picking between them is the first piece of work, not an implementation detail:

1. **A browser that survives the session** — one long-lived instance the MCP server reconnects to,
   so a crash costs a reconnect instead of the session.
2. **An isolated browser per attempt** — a fresh profile and process per tool call or per retry, so
   a crash is bounded to the attempt that caused it and the next one starts clean.

The first is cheaper per call and shares the failure; the second is more expensive and contains it.
Deciding needs the crash rate broken down by cause, which is the actual prerequisite:

- instrument the runner so a browser death is a distinguishable failure, not a slow stage
- report the rate per stage, per project, so "roughly 1 in 2" stops being an estimate
- then choose, and re-measure the same p50/p95 pair on a project that runs UI stages
