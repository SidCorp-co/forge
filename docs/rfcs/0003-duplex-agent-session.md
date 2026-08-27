# RFC 0003 — Duplex agent session

- Status: **Draft**
- Supersedes: the withdrawn [session-pooling proposal](../proposals/autonomous-session-pooling.md)
- Related: [RFC 0002](0002-park-axis-separation.md) (park axis) · [agent-driven pipeline](../proposals/agent-driven-pipeline.md) · [runner-daemon](../architecture/runner-daemon.md)

Diagrams: `docs/proposals/duplex-architecture.html` — components, lifecycle, the queueing rule, and the
ack-is-commit flow. Local only, not committed.

## Summary

A running agent gets an **inbox**. The runner spawns the CLI with a duplex channel instead of
`-p`, so core can address a session while it is alive: answer its question, inject new information,
ask it to checkpoint, cancel it cleanly. The session declares its own state instead of having it
inferred from silence.

One session serves **one job**. Sessions are **resident while working** and **durable while
waiting**. Nothing is pooled and no session outlives its job by more than a bounded, configurable
residency window whose default is zero.

## Revision 2 — what the review broke

Three independent reviews attacked this RFC on 2026-08-27. Twenty-one findings; I re-verified the
eleven load-bearing ones against the code and **all eleven held**. The shape survives — one session
per job, no pooling, declared-rather-than-inferred liveness, and ack-as-commit-point are all intact.
What failed is every place the confirmation was non-durable, non-atomic, or measuring the wrong
event, plus one whole subsystem (the question ledger's gate) that reinvented a guard this repo
deleted on purpose.

The sections below are corrected in place. This block is the record of what was wrong, because a
design doc that keeps asserting a refuted claim is the exact failure this RFC's own author committed
twice while writing it.

### Refuted, with the evidence

| Claim I made | Why it is false |
|---|---|
| *"A stream-json session that finishes a turn does not exit; it waits for input"* | True of the CLI, **false of this runner**. `claude_code.rs:45` `RESULT_EXIT_GRACE = 5s`; `:659/:665` wake on the **first** `{"type":"result"}` line, drain 5 s, then `reader.abort()` and `graceful_kill`. `awaiting_input` is unreachable until the completion task's terminal model is inverted. |
| *"Spawn differs from `build_args` in four places"* | It also requires inverting that terminal model, `RESULT_EXIT_GRACE`, the reader abort, `Outcome.result_seen` / `num_turns` / `succeeded` (all derived per-job from a marker that becomes per-turn), ISS-626's `num_turns == 0` no-work guard, and core's `kind='result'` semantics in **two** reaper queries (`loop-monitor.ts:617-623`, `:681-686`) — a duplex job that finishes turn 1 is otherwise permanently immune to `reapResultMisses`, for any cause. |
| *"Exactly one branch runs, chosen by a single authoritative ack"* | `ChildStdin` is a ~64 KiB pipe. A CLI mid-turn that is not draining stdin makes `write_all` await; core hits `deadlineMs` and calls it `gone`; then the pipe drains and the answer **is** consumed. Both branches ran. `send` has a third outcome — **unknown** — and relabelling it `gone` is only sound if `gone` were idempotent with `delivered`. It is not: `gone` mutates status and enqueues. |
| *"`gone` is always safe because it routes to the cold path"* | The cold path works today because of an accidental ordering: the job goes terminal **before** a human comments. `gone` at ~5 s inverts it — the job row is still `running`, `dispatchAutonomous` hits `jobs_active_unique`, and `autonomous-dispatch.ts:171` swallows the conflict and returns `true`. The issue then sits at `open` with **no job**, and nothing retries: `considerEnqueue` is transition-driven and the transition already happened. |
| *"The CLI queues input turns … so a message arriving mid-turn is delivered, not lost"* | `queued_turn_count` is reported in the **result** payload, i.e. a queue that can be non-empty when the process finishes. The echo proves the CLI *parsed* the line, not that the model *consumed* it. So `delivered` → `answer-resume` returns early → the queued turn is discarded at teardown → the human's answer is gone and the issue sits at `needs_info` with core having recorded success. This RFC's own failure mode, converted from visible to invisible. |
| *"the marker gains `last_written_seq`, so a daemon restart … can resume acking"* | Unimplementable. Acking needs the `ChildStdin` write end and the child's stdout; both are fds of the dead process and a `pid` in a JSON file cannot recover them. Worse, `inflight.rs:1-13` is built on *"the agent child is `setsid`-detached so it survives a daemon restart"* — true only because `cmd.stdin(Stdio::null())` (`:451`). With `Stdio::piped()` the daemon holds the **only** write end, so an involuntary daemon exit becomes an involuntary session teardown, by the very EOF mechanism this RFC adopts as its clean shutdown. |
| *"each carrying an idempotency key"* (of `seq`) | A counter incremented per attempt cannot deduplicate: a redelivery of one intent gets a new number, and two different intents can get the same one. Allocation is a read-modify-write on `agent_sessions.lastInboxSeq` with no lock and no unique constraint, and the frame loop `tokio::spawn`s a task **per frame** (`daemon/mod.rs:468-546`) with no ordering. Two sends allocate `seq 5`; the runner writes one and **acks the other `delivered` while dropping it**. |
| *"every one of them degrades to `session gone`"* (of a half-written line) | The CLI skips a bad line and keeps running. So the session is **alive** while a `cancel` or `checkpoint` has been silently lost — and core may have been acked `delivered` on the seq that did land. `DuplexSession.stdin` is unsynchronised against three concurrent writers. |
| *"Re-asking something already answered is what the ledger makes impossible"* | Two verbs cannot implement it. There is no `resolve`, nothing removes a row from the pending set, and `flush` *"always takes the whole ledger"* — so the second flush re-asks everything, including what was answered. I made the **questions durable and the answers volatile**. Two reviewers found this independently. |
| *"an agent that asks the moment it hits a blocker will park three times for one issue"* | Invented. Measured: `needs_info` = 3 issues across 104 → **parks/issue ≈ 0.03**; multi-park-per-issue has never been observed in this repo. The ledger optimises round-trip **count** where the measured cost is round-trip **latency** (0 human replies on all 17 parked issues, median park age ~360 h). |
| *"getting the gate wrong locks an agent out of asking at all"* — listed as a risk to accept | It is not a risk, it is this repo's documented history. `state-integrity-guards.md:21` records `hasHumanAnswerSince` deleted and replaced by a **content** requirement on the write, with the stated reason: *"unlike the guard it cannot strand the issue."* Flush-only `needs_info` is that guard's shape, restored. |

### Corrected design, in one place

1. **`send` takes the kill gate's durable two-phase shape.** This repo already solved *"did my command reach the runner, and may I act on not knowing?"* — `jobs.kill_requested_at` / `kill_confirmed_at` / `kill_outcome`, `resolveKillGateDecision`, `not_found`-is-a-fact backed by on-disk markers, a fallback for a runner that never answers, and a `cm:guard` (`loop-monitor.ts:233`) that an aged-out request opens a **new episode** rather than counting as an answer. My *"No retry loop, no pending state, no core decision that waits on a process"* is precisely the property the kill gate had to give up in order to be correct. `send` gets episode-scoped `send_requested_at` / `send_confirmed_at` / `send_outcome`; **`unknown` is a first-class third outcome that must be resolved, never relabelled.**
2. **The commit point moves off the echo.** Acceptance is an observable effect of the turn the message caused: the runner reports the seq that a *completed* turn consumed. Until that arrives, `answer-resume` records the answer as pending-applied and **leaves the cold path armed** — `delivered` is not permission to skip the durable path.
3. **`gone` is enforced, not inferred.** A partial write cannot be un-written, so the runner owns a hard local deadline strictly below core's, refuses a write it cannot complete before the first byte, and destroys a session it cannot vouch for. Two outcomes are reachable only if the second is *made* true.
4. **`gone` does not authorise dispatch.** `answer-resume` must first drive the old job terminal through the existing kill gate, then dispatch.
5. **A daemon restart terminates a duplex session** and reports a durable `gone`. `inflight.rs`'s module doc and the `cm:guard` on the `job.cancel` handler move in lockstep. Prerequisite: `daemon/mod.rs:276-285` drains then calls `std::process::exit(0)` **unconditionally**, unlike the update path at `:227` — a token rotation kills a resident session by design, and that is fixed first.
6. **Idempotency keys on `(intentId, kind)`**, allocated with `UPDATE … RETURNING`; the runner drops *a key already applied*, never *a number already passed*; the seq check and the write are one critical section under one mutex; arming and disarming residency is part of the same state transition.
7. **One teardown key space.** `kill-gate.ts:21` declares `cm:edge protocol` → *"`job.cancel` is the ONLY frame that kills a pipeline job process (session key = jobId)"*. `cancel` folds into it rather than adding a third semantics on a `sessionId` key, and `checkpoint` must consult `isKillEpisodeLive` — a graceful checkpoint inside a live kill episode is the two-agents-one-worktree race that guard exists to prevent.
8. **Every `send` is audited.** `cancel-job.ts:73` writes ONE `job_events` row (`kind='intervention'`) with actor and reason, in the **same transaction** as the mutation, and that row feeds the interventions-per-issue north-star metric. `inject` silently changes what a running agent does, which is arguably larger than a cancel; unaudited, it is a hole in that metric rather than an RFC-stage omission.
9. **New failure strings are declared.** `failure-classifier.ts:20` carries `cm:edge contract` → *"the runner's plain error string is its only routing lever"*, with `CLASSIFIER_VERSION` bumped on any pattern change. Send-failed, ack-timeout and checkpoint-deadline-exceeded need their strings and buckets named here.
10. **`sessionId` is minted per dispatch attempt**, on `agent_sessions`, not per job row in the payload — `resume-job.ts:81-86` flips the same `jobs.id` `held → queued` and re-dispatches the same payload, which would reuse a `--session-id` the CLI has already consumed.
11. **The residency deadline is durable and core-side** (a timestamp core can reap against), with the runner's monotonic `Instant` as an optimisation rather than the authority — otherwise a daemon restart leaks an `awaiting_input` row that the reaper is exempted from touching, on a `RUNNER_CAP_PER_RUNNER = 1` runner that then serves nothing, permanently.
12. **The question ledger loses its gate.** See the corrected section; the short form is that `add` fills a real hole and `flush`-only does not.

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

**Revision 2 corrects this.** `seq` orders; it does not deduplicate. Each message carries an
idempotency key on `(intentId, kind)` — for an answer, the `commentId` — allocated with
`UPDATE … SET last_inbox_seq = last_inbox_seq + 1 RETURNING` rather than a read-modify-write on
`agent_sessions.lastInboxSeq` with no lock and no unique constraint. The runner drops **a key already
applied**, never **a number already passed**: the old rule made two concurrent allocations of `seq 5`
(a residency `checkpoint` and a comment-driven `inject` both reading 4) resolve as one write plus one
message *dropped and acked `delivered`*, which is the silent loss this section claims cannot happen.

Ordering is not a transport property either — `daemon/mod.rs:468-546` `tokio::spawn`s a task per
frame with no ordering between handlers. The seq check and the write are therefore one critical
section under one mutex, which is also what stops two writers interleaving a half-line into
`ChildStdin`; the CLI skips a malformed line and keeps running, so that corruption leaves the session
alive with a `cancel` lost, not degraded to `gone`. Arming and disarming the residency timer belongs
to the same state transition, so an answer returning the session to `working` cannot leave a
`checkpoint` armed against a productively working agent.

Whether the replay echo carries a non-standard top-level field back at all is **not determined from
this repo** and must be measured before it is relied on.

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

**Revision 2 corrects this.** The sketch above is the right *shape* and the wrong *contract*. Three
things were wrong and each is fatal on its own:

- **There is a third outcome.** A CLI mid-turn that is not draining a ~64 KiB `ChildStdin` makes
  `write_all` await past core's `deadlineMs`; core says `gone`; then the pipe drains and the answer is
  consumed. Both branches ran. `unknown` is first-class and must be **resolved**, never relabelled
  `gone` — the two are not idempotent with each other, because `gone` mutates status and enqueues.
- **`gone` must be made true, not assumed.** A partial write cannot be un-written, so the runner owns
  a hard local deadline strictly below core's, refuses a write it cannot begin, and destroys a session
  it cannot vouch for.
- **`gone` does not authorise dispatch.** The collision I claimed removed is the collision this
  ordering *creates*: `gone` now arrives ~5 s after the comment, while the job row is still `running`
  because the daemon that would have reported it terminal is the thing that died. `dispatchAutonomous`
  hits `jobs_active_unique`, `autonomous-dispatch.ts:171` swallows it and returns `true`, and the
  issue sits at `open` with no job and nothing to retry it — `considerEnqueue` is transition-driven and
  the transition already happened. `answer-resume` must drive the old job terminal through the kill
  gate first.

And the commit point itself was the wrong event. `--replay-user-messages` proves the CLI **parsed**
the line; `queued_turn_count` being reported in the *result* payload proves a queue can still be
non-empty when the process finishes. So acceptance is the seq that a **completed turn consumed**, and
until that arrives `answer-resume` records the answer as pending-applied and leaves the cold path
armed. `delivered` is not permission to skip the durable path.

`send` therefore carries the kill gate's two-phase durable shape — episode-scoped
`send_requested_at` / `send_confirmed_at` / `send_outcome` — rather than an in-process promise with a
5 s timeout. That is the single change from which corrections 2 through 6 in Revision 2 all follow.

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

## Asking once — the question ledger

> **Revision 2 — this section is corrected, and the gate is withdrawn.** The `add` half fills a real
> hole; the `flush`-only gate reinvents a guard this repo deleted on purpose, and the premise that
> motivated it was a number I invented. What follows is the corrected design; the withdrawn version is
> recorded in Revision 2's table so the reasoning stays reviewable.

### The real hole, and it is narrow

`step-handoff-schema.ts` gives clarify an `openQuestions: string[]` capped at 10 and plan an
`unknowns` capped at 10; `prompt/user.ts` carries them into the next stage with *"For EACH item:
resolve it in your work, or explicitly acknowledge it with a reason… Do not silently drop them"*, and
`memory/signals/handoff-gap-rescue.ts` emits `handoff_gap:<from>-><to>` so deferring-then-proceeding
surfaces as **rework to be measured**. That is the settled answer to this exact problem (ISS-537).

`drive` is not in the handoff union, so autonomous mode has **no `openQuestions` equivalent at all**.
That is the hole, and it is the whole hole.

### What lands

- **`add` becomes a `PhaseArtifact` kind on `phase_journal`**, not a new table. It inherits
  `runId` / `phase` / `attempt` / `agentSessionId`, honours this RFC's own *"No new table"*, and puts
  the question where `forge_phase resume_point` already looks. Run-scoping matters concretely: with
  1.88 jobs per issue and a 43 % failure rate, a retry must not inherit questions raised against an
  approach it never took.
- **`resolve { questionId, answer }` exists**, written before the agent acts on an answer, and
  `flush` scopes to unresolved rows. Without it the ledger makes questions durable and answers
  volatile, and a session death re-asks everything — the precise outcome the withdrawn version
  claimed impossible.
- **`flush` is a composer, not a gate.** It passes the numbered batch as `transitionReason` through
  `transitionIssueStatus`. `apply-transition.ts:206-232` is already the single chokepoint: entering
  `needs_info` without a reason throws, and the reason is posted as a comment **before** the status
  write. Posting its own comment first would double-comment — which the `cm:guard` at `:207` names as
  the exact reason `skip: true` is reserved for the orchestrator — and it would also break
  `issue-detail-screen.tsx:214`, which reads the question as `comments.at(-1)?.body`.
- **A non-empty ledger is surfaced.** `me/attention-routes.ts:89` and `projects/health-routes.ts:62`
  key on status alone, so an issue at `in_progress` with three unanswered questions renders as healthy
  in-flight work. Leaving that unsurfaced inverts this RFC's own principle-№10 argument: at a 43 %
  failure rate the questions become durable, unasked, and visible nowhere.
- **Batching stays at the prompt layer**, following the precedent in `prompt/user.ts`, whose own
  block ends: *"This is prompt-layer guidance, not a status gate."* Guidance that turns out wrong
  costs an edit; a gate that turns out wrong costs the ISS-639 shape — which is why
  `dispatch-gates.ts:492` already considered and rejected `needs_info` as a blocker.
- **`blocks: 'all'|'path'|'final'` is dropped.** This RFC said *"run out of work collapses all
  three"*, i.e. nothing reads it — the has-no-consumer failure `CLAUDE.md` names for `cm:why`. If a
  discriminator is wanted later, the axis is cost-if-wrong / reversibility, not blocking radius.

### The direction decides; what it cannot decide, parks

**Owner decision, 2026-08-27.** A question is asked with its answer already attached. If no human
answers before the deadline, the agent proceeds on its own recommendation, records that it did, and
does not ask again. It stops only when it **cannot** recommend, or when being wrong is **not
recoverable**.

This is a stronger design than the version it replaces, and for the reason the review gave: the old
ledger optimised round-trip **count** on a premise I invented (0.03 parks per issue measured, not
three). This bounds round-trip **latency**, which is the cost that was actually measured — zero human
replies across all 17 parked issues, median park age ~360 h. A park that decides cannot be infinite.

#### Superseded, 2026-08-27 (second owner decision): the deadline decided nothing

The decision above left the **deadline** doing the deciding. It does not. The direction is standing,
stated once, and it answers the question before the question is asked:

> Decide on the recommendation, grounded in project information. Prefer the best and most complete
> outcome over the cheapest to build; a large workload is accepted to get there.

This is a **preference rule, not an exemption**. It says which branch to take when more than one is
open; it never says a guard may be skipped. The `reversible: false` list below therefore stays an
absolute floor — a preference cannot make an irreversible thing reversible, and no direction is read
as waiving one.

**Grounded is the load-bearing word.** The recommendation must be derived from project information —
`projectFacts`, `forge_knowledge`, project memory, the repo itself — and must name what it was derived
from. A recommendation that cannot name its grounding is not a recommendation; that question has no
basis and parks. This is the same defect the review flagged as the question-quality problem, moved
from *"composed 60 minutes later from memory"* to *"composed from nothing"*.

**What follows.** A question with a grounded recommendation that is reversible is *already answered*
by the direction. Waiting on it buys nothing — the answer will not change, and the measured reply rate
is zero over 17 parks. So it is decided **when it is found**, in the same session, and never enters
`needs_info`. That empties the deadline's population:

| | first decision: at the deadline | now |
|---|---|---|
| grounded recommendation, `reversible: true` | decide, after the wait | **decide on the spot** — no park, no status change, no second job |
| no grounded recommendation | keep waiting | keep waiting |
| `reversible: false` | keep waiting | keep waiting |

The deadline decided exactly one row, and that row no longer waits. **The park deadline, its durable
timestamp, and the expiry sweep are therefore not built.** Three sections below are superseded by
this and describe machinery that is now not scheduled: *"This deadline is not the residency window"*
(the residency timer itself is unaffected and still ships), the `At the deadline` column header on the
escape-hatch table — read it as *at the moment the question is found* — and *"The deadline is durable
and core-side"* in full. *"The record is posted before the decision is acted on"* survives and matters
more: it is now the only place the owner ever sees the decision.

**The ledger still records a decided question**, with `decidedBy: 'policy'` and the direction quoted.
It changes no status, parks nothing, schedules nothing. It exists so the owner can audit whether the
agent read the direction the way it was meant — the one failure this rule can produce that no code
here can catch.


**This deadline is not the residency window.** Two timers, two owners, two consequences: residency
asks *should this process stay alive* (seconds to minutes; the consequence is a runner slot), the park
deadline asks *should we keep waiting for a human* (hours; the consequence is the outcome of the
issue). Residency expiry checkpoints and releases a slot. Deadline expiry **decides**.

#### `add` carries the recommendation, at add time

```
forge_questions.add {
  issueId, question, context,
  recommendation,   // what I will do if nobody answers. NOT optional.
  reversible: true | false,
}
```

`recommendation` is written when the question is found, not at expiry. Composing it 60 minutes later
from memory is the question-quality problem the review flagged, and promoting it from *suggestion* to
*decision* raises the stakes on getting it right. Two omissions are the two escape hatches, and they
are the only ones:

| At the moment the question is found (was: at the deadline) | When |
|---|---|
| **decide** | a recommendation exists and `reversible: true` |
| **keep waiting** | no recommendation — the agent genuinely has no basis to prefer a branch, and says so in the field's place |
| **keep waiting** | `reversible: false` |

#### "Not recoverable" is a list, not a judgement

Left to taste this becomes the undecidable test again, used either never or always. A question is
`reversible: false` when its answer would:

- change or delete data that cannot be reconstructed from the repo
- change a published contract that other code, another package, or another team depends on
- touch auth, permissions, money, or a customer-visible default
- run a migration
- **contradict a decision a human already recorded on this issue** — the ownership line in `CLAUDE.md`
  forbids silently overriding one, and this is the item most likely to be missed, because the
  recommendation will often look better than the decision it would override

Everything else is `reversible: true`, including work that is large. Size is not impact.

#### Best for the result, not cheapest to build

The recommendation names the outcome that is **best**, explicitly not the one that is least work. This
has to be stated because the default incentive runs the other way: an agent choosing between the
narrow fix and the right one defaults to narrow, and a deadline turns that preference into shipped
behaviour rather than into a question somebody reviews. If the better answer is the more expensive
path, that is not a reason to prefer the other.

#### The record is posted before the decision is acted on

Not after. `apply-transition.ts:206-232` already establishes the shape and the reason: the transition
reason is posted as a comment **before** the status write, because a park that commits without its
reason is an unexplained park. A decision that commits without its record is an unexplained decision,
and at a 43 % drive-job failure rate the session that would have posted it afterwards may not survive
to do so. One comment per expiry, naming each question, the recommendation taken, and that nobody
answered in time.

#### The deadline is durable and core-side

A timestamp on the question row that core sweeps — not an in-memory timer on the runner. Same
correction as Revision 2 item 11, for the same reason: an in-process timer dies with the daemon, and
`inv7-alarms.ts` already has the sweep shape for an aged hold.

#### Two consequences this creates

**Notification stops being a preference and becomes a prerequisite.** I had sequenced the
`NOTIFY_ON_STATUS` fix as *should land first*. Under this rule it **must**: `needs_info` is absent
from `NOTIFY_ON_STATUS`, and all 17 parked issues have zero human replies.

*Amended by the second decision.* This paragraph read the outcome *"always decide, never ask"* as the
failure mode. For the grounded-and-reversible class it is now the **intent**, so there is no
ask-and-wait path left to be dead on arrival. The gap it names gets worse rather than better: after
the second decision the only issues that park are the ones that genuinely cannot be decided here, so
a park nobody is notified about is no longer one unread question among many — it is the entire
remaining population, and it is exactly the population a human is the only possible answer for.

**A late answer must not be dropped silently.** `answer-resume.ts` requires
`status === 'needs_info'`; once a deadline has expired and the agent has moved on, the issue is no
longer parked, so `resumableIssue` returns null and a human's answer is discarded without a word.
Today that is rare. Under this rule it is routine, and it is the wrong behaviour: the human answered,
the answer may contradict a decision already acted on, and nobody is told. A late answer against a
decided question must reopen **that decision specifically**, as a comment naming what it contradicts.
Dropping it is the state-never-lies violation (principle №10) that this whole RFC is otherwise trying
to pay down.

*Amended by the second decision.* A policy-decided question never enters `needs_info`, so
`answer-resume.ts` is not the path that drops the late answer — there was no park to answer against,
and the human was never asked. The concern survives in a harder form: the owner's first sight of the
decision is a comment on an issue nobody notified them about, and disagreeing with it has no
mechanism at all. Whatever reopens a decision must therefore work from a plain comment on a
non-parked issue, not from the answer path.


#### What this settles

`blocks: 'all'|'path'|'final'` is gone and does not come back. The review's verdict was that the
useful axis is cost-if-wrong / reversibility rather than blocking radius; this rule makes exactly that
axis load-bearing, and it is the only axis the deadline reads.

### What is withdrawn, and why

**Flush-only `needs_info`.** `state-integrity-guards.md:21` records `hasHumanAnswerSince` deleted and
replaced by a content requirement on the write, for the stated reason *"unlike the guard it cannot
strand the issue."* The gate is that guard's shape restored, and it breaks four legal writers:
sub-agents forked by the driver (`forge-ship` at phase 7 with the branch merged and the deploy dead —
*"the exact state that looks finished and is not"* — would have no work left and no legal way to ask),
chat (`guards.ts:14`), the human UI (`use-guarded-transition.tsx:15`), and **this repo's own checker**,
whose R1 forces the skill table to equal `AUTONOMOUS_DRIVER_STATUSES` *including* `needs_info`. The
checker compares status **sets**, never **how** a status may be written, so it would read green on the
contradiction — the same false-closure failure already found once while writing this RFC.

**"Ask once" as a kernel rule.** The premise was that an agent asking on first blocker parks three
times per issue. Measured: 3 `needs_info` issues across 104, so ≈ 0.03 parks per issue, and
multi-park-per-issue has never been observed here. The measured cost is latency, not count: zero human
replies on all 17 parked issues, median park age ~360 h. `inv7-alarms.ts` alarms a 6-hour hold while a
355-hour `needs_info` has no equivalent, and `needs_info` is absent from `NOTIFY_ON_STATUS`.

**Sequencing, therefore:** the notification and aged-park alarm land **before** any of this. Until
`needs_info` notifies somebody, a ledger strictly increases time-to-human-attention whatever else it
improves.

### Deferring is not free, and one case forbids it

`forge-understand/SKILL.md:37-45` — *"Nothing proceeds on a described symptom… If you cannot reproduce
it, do not proceed on the assumption that it is real."* The commonest phase-1 blocker is exactly the
one where *record it and keep going* tells the agent to plan and code against an unverified premise:
three phases of work whose only foundation is the thing it wrote down instead of asking. Nothing here
changes that instruction, and `add` must not be read as licence to pass it.

Whether agents under-flush or over-flush in practice is **unmeasured** — the checker's own header says
what it cannot see: *"what an agent actually wrote at runtime… lives in `activity_log` and CI has no
database."*

## Drawbacks

- Two exec paths to maintain until print mode is retired.
- The question ledger is a new durable surface (`forge_questions`) and a new gate on `needs_info`.
  Getting the gate wrong locks an agent out of asking at all, which is worse than asking twice — so
  it ships with the flush path, never before it.
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

---

# Implementation

Everything below is the applicable half: types, wire format, and a build order where each phase lands
green and is useful on its own.

## Two protocols, one translator

The CLI's stream-json input is **not** Forge's protocol. Core speaks an envelope to the runner; the
runner renders it onto the CLI's stdin. Keeping them separate is what lets the CLI's format change
without touching core.

```
core ──[ session.send envelope, over the existing /ws ]──► runner
                                                             │  renders
                                                             ▼
                                          {"type":"user","message":{...}}  ──► CLI stdin
```

### Envelope — core → runner

```jsonc
{
  "type": "session.send",
  "sessionId": "<uuid>",          // minted by core, also passed as --session-id
  "seq": 4,                       // monotonic per session, assigned by core
  "kind": "answer",               // work | answer | inject | checkpoint | cancel
  "body": "…",                    // absent for cancel
  "deadlineMs": 5000              // how long core will wait for the ack
}
```

### Ack — runner → core

```jsonc
{ "type": "session.ack", "sessionId": "…", "seq": 4, "result": "delivered" }
{ "type": "session.ack", "sessionId": "…", "seq": 4, "result": "gone", "reason": "residency_expired" }
```

**`send` has exactly two outcomes.** `delivered` or `gone`. A missing ack past `deadlineMs`, a device
with no live socket, an unknown `sessionId` — all `gone`. `gone` is always safe because it routes to
the cold path, which stays load-bearing.

### How each kind is rendered

| kind | runner action |
|---|---|
| `work` | one stream-json user message; **once per session**, a second is `gone` with `reason: "work_already_sent"` |
| `answer` | one user message, framed as the human's reply |
| `inject` | one user message; pending `inject`s coalesce into the latest before writing |
| `checkpoint` | one user message asking for a resume point, then wait for the turn to end |
| `cancel` | `checkpoint`, then close stdin; `graceful_kill` on deadline |

## Runner: `DuplexClaudeRunner`

A second `Runner` impl. The trait is unchanged — `send` stops returning `NotImplemented`.

```rust
pub struct DuplexSession {
    child: Child,
    stdin: ChildStdin,                    // was Stdio::null()
    last_written_seq: u64,
    pending_inject: Option<String>,       // coalescing slot
    state: RuntimeState,                  // starting|working|awaiting_input|checkpointing|closed
    residency: Option<Instant>,           // deadline, set when core says awaiting_input
}

pub enum RuntimeState { Starting, Working, AwaitingInput, Checkpointing, Closed }
```

Spawn differs from `build_args` in four places:

```rust
cmd.stdin(std::process::Stdio::piped());              // was Stdio::null()
args.push("--input-format".into());  args.push("stream-json".into());
args.push("--replay-user-messages".into());
args.push("--session-id".into());    args.push(spec.session_id.clone());
// and `-p` no longer carries the prompt — it becomes the `work` message
```

`send` is idempotent by `seq`: drop anything at or below `last_written_seq`, then write and await the
CLI's replay echo before acking `delivered`.

Two new events on `RunnerEvent`:

```rust
TurnEnded { turn: u64 },                  // a {"type":"result"} line on stdout
StateChanged { state: RuntimeState },
```

Crash recovery reuses `runner/inflight.rs`: the marker gains `last_written_seq`, so a daemon restart
that finds a live child can resume acking without replaying a message.

## Core: the send path

```ts
type SendResult = { ok: true } | { ok: false; reason: 'gone' };

// packages/core/src/sessions/session-send.ts
export async function sendToSession(
  sessionId: string,
  kind: 'work' | 'answer' | 'inject' | 'checkpoint' | 'cancel',
  body?: string,
): Promise<SendResult>;
```

It resolves the session's `deviceId`, allocates the next `seq`, publishes over the device's socket,
and awaits the ack. No retry loop, no pending state, no core decision that waits on a process.

`answer-resume.ts` gains exactly one branch — **the ack is the commit point**:

```ts
const sent = await sendToSession(session.id, 'answer', comment.body);
if (sent.ok) return;                    // the agent continues; do NOT transition or dispatch
await transitionIssueStatus(/* → open, today's path */);
```

## Schema

Two columns, one config key, and — since Revision 2 — **one new table**. The draft said "no new
table" on the strength of *"no retry loop, no pending state"*, and corrections 1, 2 and 6 each
independently require a durable per-message row: an episode to scope the answer, an idempotency key
that a per-attempt counter cannot be, and a commit point that is not the echo.

```ts
// agent_sessions
runtimeState: text('runtime_state', { enum: sessionRuntimeStates }),   // NULL = print mode, infer nothing
lastInboxSeq: integer('last_inbox_seq').notNull().default(0),
```

```ts
// session_inbox — one row per INTENT, not per attempt
seq, kind, intentId,                                    // unique (session, kind, intentId)
sendRequestedAt, sendConfirmedAt, sendOutcome,          // the episode, mirroring the kill gate
appliedAt, appliedTurn,                                 // the commit point: a COMPLETED turn consumed it
```

Three timestamps because there are three different questions, and the draft conflated the second and
third. `sendConfirmedAt` records what the runner said; `appliedAt` records the only event that means
the model read the message. A caller may stand down its durable path on `appliedAt` and never on
`sendConfirmedAt`.

`runtimeState` ships nullable rather than `notNull().default('starting')`: a print-mode session never
reports one, and a default would assert a runtime state for every session in the table that no runner
ever observed.

```ts
// pipelineConfig
sessionMode: 'print' | 'duplex';        // default 'print'
sessionResidencySeconds: number;        // default 0
```

`runtimeState` narrows what the reaper has to guess. The quiet-timeout applies **only** while
`runtimeState = 'working'`; `awaiting_input` is exempt and bounded by residency instead.

**Scope this claim precisely, because it is easy to overstate.** What is fixed is the *park*: a
session waiting on stdin declares that it is waiting, instead of beating a synthetic `progress` event
that asserts something it cannot observe. That is a real principle №10 repayment and it is the whole
of it.

What is **not** fixed is a wedge *inside* a turn. A turn can run the length of the job, the 25 s beat
still fires throughout `working`, and a stuck agent and a thinking agent remain the same observation.
This RFC moves the ambiguity from between turns to inside one; it does not remove it. Distinguishing
those two needs a progress signal with semantics — phases, tool calls, diff growth — and that is not
this RFC.

## Turn end: report, then classify

The runner reports the observable fact; core owns the meaning.

```
runner: TurnEnded ──► core reads the issue's status
                        needs_info        ──► session.state = awaiting_input + residencySeconds
                        closed | dropped  ──► session.close
                        anything else     ──► session.send checkpoint, then close, cold path
```

The runner never classifies a turn end. A self-reported state would be the
claim-instead-of-measurement this repo refuses elsewhere.

## Build order

| # | Lands | Useful on its own because |
|---|---|---|
| 1 | `DuplexClaudeRunner` behind the flag, `work` only | one message, one turn, one result — effectively print mode, so it proves the plumbing writes a line and reads a reply. It does **not** prove a session survives a turn: `claude_code.rs:651-666` tears the child down `RESULT_EXIT_GRACE` = 5 s after the *first* `result` line, and `result_seen` / `num_turns` (ISS-626's `no_work`) / `succeeded` / `result_error` are all derived per-job from that same marker. **Inverting that terminal model is the real work of this RFC and it belongs in this row**, not silently in phase 2. Open: which turn's `num_turns` decides `no_work`, and does `spec.timeout_seconds` cover the residency wait |
| 2 | `TurnEnded` + core classification + `runtimeState` | turn-end classification replaces inference-from-silence for the **anomaly** case — a turn that ended with the work unfinished is now a reported fact rather than a timeout. Note what this row does **not** buy: at residency 0 `awaiting_input` exists for milliseconds and nothing observes it, so the *working*-vs-*awaiting-input* dashboard needs phase 3 |
| 3 | `answer` + ack-is-commit in `answer-resume` + the residency timer | the park fast path; safe at every residency value including 0 |
| 4 | `inject`, `checkpoint`, `cancel` replacing signal-kill | steering a live agent, and a teardown that writes down what it knew |

Phase 2 is the one that pays first, and it pays without turning residency on at all.

**Chat first.** `daemon/chat.rs` is a conversation that has been running one-shot the whole time and
needs no residency window. It is the honest smoke test for phases 1 and 4, and it exercises `send`
before any pipeline job depends on it.

## Lockstep

- `forge-drive/SKILL.md` — *"Then **end your session**"* becomes *"then finish your turn"*. Ship it
  with phase 3, never before: under `sessionMode: 'print'` waiting really is a lie.
- `jobs/loop-monitor.ts` — the quiet computation reads `runtimeState`. Ships with phase 2.
- `docs/architecture/runner-daemon.md` — the spawn description. Ships with phase 1.
- **`docs/modules/issues-pipeline/autonomous-status.md` (THE STANDARD) and
  `scripts/check-autonomous-transitions.mjs` — no longer coupled, and that is the point.** The
  withdrawn version put two rules over one status: S1 said the driver may write `needs_info`, the gate
  said only `flush` may. R1 validates S1 against the skill's status table, so a skill rewritten to
  *"call `flush`, never set the status"* would have broken it — and, worse, a skill that kept the old
  wording would have passed R1 while misinstructing the agent, because R1 compares status **sets** and
  never **how** a status may be written. Withdrawing the gate dissolves that coupling: `needs_info`
  stays directly writable by the driver, S1 and S4 are unchanged, and the checker needs no new rule.
  This bullet stays as the record of a lockstep that a design change removed rather than satisfied.
