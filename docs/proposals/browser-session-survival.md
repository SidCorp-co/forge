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

## Half the instrumentation is already there, and one line forecloses the other half

A browser MCP that fails to connect **at startup** is already a named, distinguishable failure:
`classify_failure_reason` in `runner/claude_code.rs` returns
`[MCP_INIT_FAILED] chrome-devtools(failed) did not connect at startup`, per server, and core's
failure classifier matches that token.

What is not distinguishable is a server that connected and then **died mid-session** — which is the
symptom the p95 above measures. The reason is one line in the stdout reader:

```rust
if !got_init {
    if let Some(failed) = mcp_failed_servers(&json) { got_init = true; ... }
}
```

`mcp_failed_servers` reads any `system` event carrying `mcp_servers`, but `got_init` makes the reader
consume the FIRST one and ignore every later one. So the shape of the fix is small and local — keep
reading those events past init — and it is still not safe to make blind, because nothing here can
say whether the CLI emits a `system`/`mcp_servers` event when a server dies mid-turn. If it does not,
the change is inert; if it emits one for an unrelated reason, `mcp_failed` gets overwritten late and
`[MCP_INIT_FAILED]` starts being reported for jobs that connected fine.

That is the whole prerequisite, reduced from "instrument the runner" to a question someone with a
crashing browser in front of them can answer in one session: **does a mid-session MCP death produce a
`system` event with `mcp_servers`?** Yes → drop `got_init` for that branch and give the death its own
token. No → the signal has to come from somewhere else, and that is a bigger piece of work.

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

- answer the `got_init` question above, then make a browser death a distinguishable failure rather
  than a slow stage (startup failures already are)
- report the rate per stage, per project, so "roughly 1 in 2" stops being an estimate
- then choose, and re-measure the same p50/p95 pair on a project that runs UI stages

## Honest costs

- **The prerequisite is a person watching a browser die.** The `got_init` question is answerable only
  from a live crash, so closing this costs a session that cannot be spent reading code — which is
  precisely why it is still open.
- **Both shapes carry a standing bill.** A surviving browser shares one failure across every attempt
  and lets state leak between them; an isolated one pays a process launch per attempt in wall-clock
  and in memory on a runner box that is also running the agent.
- **New failure tokens are a contract.** Making a mid-session MCP death distinguishable adds a token
  core's classifier, the alarms and every dashboard reading them have to learn, and a token reported
  for the wrong cause is worse than a slow stage.
