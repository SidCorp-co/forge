# Autonomous session pooling

- Status: **measured 2026-08-27, recommendation is yes-with-a-boundary** — the mechanism is real, the scope asked for is not the scope the numbers support.
- Related: [agent-driven pipeline](agent-driven-pipeline.md) · [autonomous status](../modules/issues-pipeline/autonomous-status.md) · [retry continuity](retry-context-continuity.md)

## The ask

Replace print mode: the runner spawns a Claude session that waits, and pools jobs to it.

## The mechanism exists

`--input-format stream-json` (with `--print` and `--output-format stream-json`) is a long-lived
process that reads newline-delimited user messages on stdin and streams events on stdout. It stays
alive between messages. `--replay-user-messages` re-emits each stdin message on stdout, which is the
job-accepted acknowledgement a pool needs. Both are in `claude` 2.1.247.

The runner today (`crates/forge-runner-core/src/runner/claude_code.rs`, `build_args`) already passes
`--output-format stream-json --verbose --include-partial-messages`, so the only change on the output
side is none. The input side changes from `-p <prompt>` to a written stdin stream.

## What the numbers say about pooling many issues into one session

| Measured 2026-08-27 | Value |
|---|---|
| `claude` cold start, real `--mcp-config`, to first API request | **~7.5 s** wall (API itself 1.7–1.9 s) |
| `drive` job duration, last 30 days, 59 finished jobs | **p50 4026 s** · p95 11654 s · avg 4701 s |
| Startup as a share of a median drive job | **0.19 %** |
| Prompt-cache read on a **second, separate** process | 44,684 tokens · $0.0058 vs $0.0439 cold — **7.5× cheaper** |

Two things follow.

**The startup cost pooling removes is 0.19 % of a drive job.** A 67-minute median job does not care
about seven seconds.

**The warm cache pooling is supposed to buy, you already have.** The 44,684-token cache read above
happened in a *different process* from the one that created the entry — the prompt cache is
server-side and keyed on the prefix, so consecutive jobs sharing a system prompt hit it without any
pool. Cost per job is already at the warm number.

## Why pooling many issues into one session is wrong, not merely unnecessary

**Cross-job context bleed, verified.** One session, two messages 25 s apart:

```
→ "Remember this secret word: ZANZIBAR. Reply only: stored"     ← "stored"
→ "What secret word were you told earlier?"                     ← "ZANZIBAR"
```

Job N+1 sees job N's whole transcript. There is no in-band control message to start a fresh
conversation on a live stream-json session — `--fork-session` works only on `--resume`, at spawn.
Three consequences, in order of how much they cost:

1. **The reviewer isolation breaks.** `forge-drive` forks a clean-context reviewer precisely so it
   *"must be able to reach a different conclusion than you did"*. A shared transcript is the one
   thing that design exists to prevent.
2. **`--autocompact` fires mid-job.** Context accumulates across issues until the compact window
   hits, and it will hit inside somebody's 67-minute drive rather than between jobs.
3. **Leakage between projects.** One pooled session on a multi-project runner has read another
   project's code and credentials-adjacent output.

## Where the same mechanism does pay: one issue, across its park

The stated problem is that print mode leaves a dead process between interactions. That is true, and
it costs something measurable — just not at job boundaries. It costs at the **park**:

- The driver's only resuming park is `needs_info` ([S2](../modules/issues-pipeline/autonomous-status.md)).
- Eight issues currently sit parked for an average of **758 hours**.
- A human's answer today triggers a cold `--resume`, which is the failure path
  `claude_code.rs` handles at `resume_failed` — a resume that cannot find its session is a job that
  restarts from nothing.

Keeping **one issue's** session alive across its park turns that answer into a message written to a
living process: no resume, no lost session, no re-derivation of where it stopped. Same flag set the
ask names, applied to the boundary the evidence supports.

## Recommended params

| Param | Why |
|---|---|
| `--input-format stream-json` | the persistent-process mechanism; keep `--output-format stream-json --verbose --include-partial-messages` as today |
| `--replay-user-messages` | ack that a message was accepted, so the runner can distinguish "queued" from "picked up" |
| `--session-id <uuid>` | the runner mints the id instead of scraping `session_id` off the stream (`claude_code.rs` line 552), so the ledger has it before the first event |
| `--fork-session` | on the resume path only: a new id rather than reusing one, which sidesteps the `resume_failed` branch |
| `--max-budget-usd` | a per-job ceiling, which a long-lived session needs more than a print-mode one |
| `--autocompact <tokens>` | set it explicitly for a session held across a park, rather than inheriting `auto` |

Not recommended: `--bare` and `--safe-mode` strip CLAUDE.md discovery and skill resolution, which the
drive model depends on.

## Decision needed

One session per **issue**, held across that issue's park — yes, and it is a real fix for the 758-hour
number. One session per **runner**, pooling issues — no, on four independent measurements above.
