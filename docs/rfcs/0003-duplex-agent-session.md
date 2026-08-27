# RFC 0003 — Duplex agent session

- Status: **Draft**
- Supersedes: the withdrawn [session-pooling proposal](../proposals/autonomous-session-pooling.md)
- Related: [RFC 0002](0002-park-axis-separation.md) (park axis) · [agent-driven pipeline](../proposals/agent-driven-pipeline.md) · [runner-daemon](../architecture/runner-daemon.md)

## Summary

A running agent gets an **inbox**. The runner spawns the CLI with a duplex channel instead of
`-p`, so core can address a session while it is alive: answer its question, inject new information,
ask it to checkpoint, cancel it cleanly. The session declares its own state instead of having it
inferred from silence.

One session serves **one job**. Sessions are **resident while working** and **durable while
waiting**. Nothing is pooled and no session outlives its job by more than a bounded, configurable
residency window whose default is zero.

## Motivation

Print mode makes a running agent **unaddressable**. That is the defect — not startup cost, which is
7.5 s against a p50 drive job of 4026 s (0.19 %), and not resume fragility, which does not exist for
this mode (`jobs/resume-policy.ts:145` excludes drive jobs from `--resume`; `resume_failed` fired 0
times in 90 days).

Three consequences follow from unaddressability, and none of them is fixable by tuning:

1. **A question ends the session.** Asking costs the agent everything it has built. A design that
   makes the correct action expensive gets the incorrect one; the fleet wrote `waiting` 27 times
   against `needs_info` twice.
2. **State is inferred from silence.** `daemon/dispatch.rs:554` beats a synthetic `progress` event
   every 25 s because there is no way for the process to *say* what it is doing. The reaper then
   cannot distinguish thinking from wedged, which is the "it has run for three hours and I cannot
   tell if something is wrong" complaint at its root.
3. **Teardown is a kill.** `abort` sends a signal (`claude_code.rs:826-834`). Whatever the agent
   knew that it had not yet written down is lost.

**The contract already anticipates this.** `Runner::send(&self, session, message)` is declared in
`runner/mod.rs:119` and `ClaudeCodeRunner` returns `NotImplemented` for it (`claude_code.rs:821-824`)
with the comment *"Interactive follow-ups are a chat feature; pipeline jobs are one-shot."* This RFC
implements that method. It does not introduce the abstraction; it fills a hole the trait already
names.

## What this RFC does not propose

**No pooling.** Multiplexing several jobs onto one session is self-defeating: the only thing it buys
is a warm prefix, and the only mechanism that makes it safe — an in-band `/clear`, verified to emit
a `conversation_reset` event on `claude` 2.1.247 — destroys exactly that. Pooling with isolation is
spawning, plus shared fate: one crash, leak or poisoned state affects N jobs instead of one. Process
state (cwd, the per-issue worktree, env, `FORGE_VERDICT_FILE`) is not multiplexable across repos in
any case.

**No unbounded residency.** Holding a process across a wait that has no bound is the wrong shape for
human-in-the-loop work regardless of implementation. Durable state and rehydration is the answer;
residency is an optimisation on top of it, never a replacement.

## Guide-level explanation

**For an operator.** A job that is thinking says *working*. A job that has asked a question says
*awaiting input* — alive, not progressing, and correct. Those are different words, and the dashboard
can finally show which one you are looking at. A job that has been asked to stop writes down where
it got to before it exits.

**For core.** You address a session by id and send it a typed message. Delivery either succeeds or
tells you the session is gone; "gone" is normal and routes to the cold path you already have.

**For the agent.** Asking a question no longer ends you. You keep your context while the answer is
plausibly coming, and when it is not, you are asked to checkpoint rather than killed.

## Reference-level explanation

### The session object

| | Today | This RFC |
|---|---|---|
| identity | scraped off stdout (`claude_code.rs:552`) | minted by core, passed as `--session-id <uuid>` |
| outbox | stdout, `--output-format stream-json` | unchanged |
| **inbox** | `Stdio::null()` | `Stdio::piped()` + `--input-format stream-json` |
| ack | none | `--replay-user-messages` echoes each accepted line |
| state | inferred from silence | declared by the runner |

### Inbox message kinds

Five, each carrying an idempotency key so a redelivered message is dropped rather than applied twice.

| kind | meaning | replaces |
|---|---|---|
| `work` | the job's opening prompt | `-p <prompt>` |
| `answer` | a human's reply to the agent's question | a whole re-dispatch |
| `inject` | information that arrived mid-run — a comment, a spec change, a revoked assumption | nothing; impossible today |
| `checkpoint` | "write your resume point now" | nothing; today teardown is a kill |
| `cancel` | stop cleanly, after checkpointing | `abort` → signal |

The CLI queues input turns rather than dropping them — the result payload reports
`queued_turn_count` — so a message arriving while the agent is mid-turn is delivered, not lost.

### Session states

```
starting ──► working ⇄ awaiting_input ──► checkpointing ──► closed
```

`working` emits progress. `awaiting_input` is a **distinct** liveness signal meaning *alive, not
progressing, and that is correct*. This is the half that repays principle №10: today the 25 s beat
asserts progress for anything that has not exited, so a wedged job and a thinking job are the same
observation. Here the reaper reads a declared state, and the two are different rows.

`checkpointing` is entered on `checkpoint` or `cancel`, bounded by a short deadline; on expiry the
runner falls back to today's `graceful_kill`.

### Slot accounting

`working` and `awaiting_input` both hold a slot, because in both a process is running. That is the
honest accounting and it needs no change to `dispatch-gates.ts`. **The residency bound is therefore
the slot bound** — which is why it is bounded, and why `held` (RFC 0002) is not reused: `held` is
slotless *because nothing is running*, and its `HOLD_REASONS` guard refuses business outcomes
outright.

### The residency window

On entering `awaiting_input` the runner starts a timer, `sessionResidencySeconds`, per project.

- Answer arrives inside the window → written to the inbox. The agent continues with full context.
- Window expires → `checkpoint`, then clean stdin close. The CLI exits, the session records
  `completed`, and the issue stays at `needs_info`. The answer then takes today's cold path,
  unchanged.

**Default: `0`.** Ship the channel with the fast path disabled. Today all 17 parked issues have zero
human replies, so a residency window would fire never and cost slots for nothing. Turning it on is a
separate decision that becomes measurable only once `needs_info` notifies somebody — see
[the withdrawn proposal](../proposals/autonomous-session-pooling.md) for why it currently does not.

This is what makes the design **additive**: the cold path stays load-bearing and correct at every
value of the window, including the default.

### Ownership

Core owns **work**; the runner owns **process**. The contract:

- Core sends by `sessionId` and gets delivered-or-gone. Never a third answer.
- The runner may end residency unilaterally — upgrade, drain, reboot, OOM — but must `checkpoint`
  first and must report the reason.
- Core treats "session ended before the job finished" as **normal**, routed to the cold path, never
  as a failure.

That last line is what removes the split-ownership hazard: no core decision depends on a process
continuing to exist.

### Migration

The trait does not change. `DuplexClaudeRunner` is a second `Runner` implementation behind the same
interface; `JobSpec` gains an optional channel mode. Print mode remains the default and the fallback
for one release, selected per project, so the shared exec path
(`daemon/mod.rs`, `daemon/chat.rs`, `daemon/dispatch.rs`) is never cut over wholesale — the risk
`docs/architecture/skill-delivery.md:49` recorded when it deferred exactly this change.

Chat is the natural first consumer and the honest smoke test: it is a conversation that has been
running one-shot this whole time, and it needs no residency window at all.

## Drawbacks

- Two exec paths to maintain until print mode is retired.
- `awaiting_input` is new liveness vocabulary: the loop monitor, the sweeper and the dashboards all
  learn a state that did not exist.
- A duplex channel is a new failure surface — a half-written line, a full pipe, a wedged reader. The
  mitigation is that every one of them degrades to "session gone", which is already handled.
- It fixes none of the measured top problems: 43 % of drive jobs failed over 90 days, and
  `needs_info` notifies nobody. This RFC is a capability, not a remedy for either.

## Unresolved

- The `checkpoint` deadline, which needs one round of measurement against real agents.
- Whether `inject` should interrupt the current turn or queue behind it. Queuing is the safe default
  and what the CLI already does; interrupting is a later question.
- Whether the CLI re-reads `--mcp-config` after `system/init`, which decides whether a long-resident
  session survives a device-token rotation. Not determinable from this repo.
