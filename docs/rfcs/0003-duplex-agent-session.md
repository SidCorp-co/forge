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

### One session per job — which is not one per issue

The unit is the **job**, not the issue, and an issue is not one job:

```
issue  ──►  1..N jobs        measured: 195 drive jobs / 104 issues = 1.88
 job   ──►  exactly 1 session      one claim, one spawn
session ──► all 7 phases           same process throughout
phase 5 ──► an in-process Task fork, NOT a second session
```

`claude_code.rs` spawns exactly one child per job (line 492, the only `spawn()` in the file), so the
reviewer the driver forks in phase 5 — and every sub-agent skill, `forge-understand` / `plan` /
`review` / `ship` — lives inside that one session. A `request_changes` round goes back to phase 3 in
the same session too.

**At most one live session per issue at any instant**, enforced by `jobs_active_unique` on
`(issueId, type)`, partial on `status IN ('queued','dispatched','running','held')`.

What creates a *second* session for the same issue is a second job: a park answered outside the
residency window, or a retry after a failure. Of the two, **retry dominates** — 84 of 195 drive jobs
failed over 90 days (43 %), against 29 parks. So the residency window is the knob that moves
sessions-per-issue toward 1, but it is the smaller of the two levers; the failure rate is the larger
one and this RFC does not touch it.

### Three queues, three owners — and one rule

An inbox adds a queue. The hazard is not the queue, it is that two queues could now decide the same
thing.

| queue | owner | holds | rule |
|---|---|---|---|
| job queue (pg-boss) | core | work that has not started | unchanged — **the only scheduler** |
| runner slot | `dispatch-gates.ts` | which job may start now | unchanged — `RUNNER_CAP_PER_RUNNER = 1` |
| session inbox | the session | messages **about the job it is already running** | never a second job |

> **THE RULE: work enters only through the job queue. The inbox never admits work.**

That is what makes this not-pooling at the protocol level rather than by convention. `work` is sent
exactly once per session, as the first message; a session that receives a second `work` rejects it.
Every other kind is scoped to the job that session is already running. No new scheduler exists, and
`dispatch-gates.ts` remains the single answer to "what runs where".

### Ordering, redelivery, backpressure

Core assigns a monotonic `seq` per session. The runner writes in `seq` order and drops any `seq` at
or below the last one written, so a redelivered message is idempotent without the agent seeing it
twice. `--replay-user-messages` echoes the accepted line; that echo carries the `seq` back and is
what marks the message delivered.

The CLI queues input turns rather than dropping them (`queued_turn_count` in the result payload), but
an unbounded queue is its own defect: fifty comments arriving during a long turn should not become
fifty turns. So:

- **`inject` coalesces.** Several pending `inject`s collapse into one *"here is what changed"*. The
  agent needs the current state, not the arrival history.
- **`answer`, `checkpoint` and `cancel` never coalesce and are never dropped.** If the inbox cannot
  take one, that is a `gone`, not a silent loss.

### Spawn

One job claim, one spawn. Never a spawn without a claim; never a claim without a spawn. Session
lifetime is therefore bounded by job lifetime plus the residency window, which defaults to zero.

1. The runner claims the job through the existing lease / `inflight` machinery.
2. `sessionId` arrives **in the `JobSpec`** — core minted it. Nothing is scraped from stdout.
3. The runner writes the MCP config and spawns with `Stdio::piped()`.
4. The runner writes `work` as `seq 1`.
5. `starting → working` on the first assistant event.

### Turn end is reported, never interpreted, by the runner

The agent asks its question by setting `needs_info` through MCP — which the runner cannot see, and
must not be told by the agent, because a self-reported state is the claim-instead-of-measurement this
repo already refuses elsewhere.

So the runner reports the one thing it can observe — **the turn ended** — and core, which owns the
state, decides what that means:

| issue status when the turn ends | meaning | action |
|---|---|---|
| `needs_info` | the agent asked a question | `awaiting_input`; start the residency timer |
| `closed` / `dropped` | the agent finished | close the session; job `done` |
| anything else | the turn ended with the work unfinished — an anomaly | `checkpoint`, close, route to the cold path |

A stream-json session that finishes a turn does not exit; it waits for input. That is what makes
`awaiting_input` a state rather than a death, and it is why the skill's *"then end your session"*
becomes *"then finish your turn"* — a policy change, not a kernel one.

### The answer race, and why `answer-resume` stops colliding

Core must never both deliver an answer and dispatch a fresh job for it. So **the ack is the commit
point, not the send**:

```
answer-resume  ──►  send(sessionId, answer)
                      ├─ delivered ──► the agent continues; core does NOT transition or dispatch
                      └─ gone      ──► core transitions to `open` and dispatches (today's path)
```

Exactly one branch runs, chosen by a single authoritative ack. This also removes the collision the
capacity review found: under a naive design the parked job is still `running`, so
`dispatchAutonomous` hits `jobs_active_unique` and `autonomous-dispatch.ts:171` swallows the
conflict. Here that dispatch is never attempted — if the job is still running, `send` returned
`delivered`.

`send` therefore has exactly two outcomes and no third. There is no pending state, no retry loop, and
no core decision that waits on a process. A device that is offline is `gone`.

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
- The `forge-drive` skill's *"Then **end your session**. Do not wait, poll, or keep the run alive"*
  becomes *"finish your turn"* under a duplex channel. That line exists because under print mode
  waiting was a lie — the process was going to die anyway. It stops being one, but the skill must be
  changed in lockstep with the channel or the agent will keep ending sessions that could have waited.
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
- What the runner does with a turn that ends while core is unreachable. It cannot classify the turn
  end itself (that is the whole point of the table above), so it must either hold the session on a
  short timer or checkpoint and close. Closing is the safe default; holding is the one that keeps the
  fast path alive across a brief core outage.
- Whether the CLI re-reads `--mcp-config` after `system/init`, which decides whether a long-resident
  session survives a device-token rotation. Not determinable from this repo.
