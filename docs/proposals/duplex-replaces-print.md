# Duplex replaces print mode — full plan to a fleet with one session model

Scope: RFC 0003 shipped as a **replacement**, not a permanent per-project flag. Ends with
`sessionMode` deleted, `print` gone, and the one-shot lanes that exist only to serve it removed.

Tracked as **ISS-873** — that issue is the contract (outcome, invariants, out-of-scope); this
document is the route (per-phase file order, the Deletes column, lockstep). Keep them in step: a
phase that lands here updates the issue's Landed list.

Companion: `docs/proposals/duplex-architecture.html` (drawn). Where it describes `sessionMode` as
the end state, this document supersedes it: it is a migration device with a scheduled deletion.
RFC 0003, which held the design, was deleted in the 2026-08-28 docs cleanup — this document and the
drawing are what remain of it.

## Goals

Five goals, measured. The phase table below is *how*; these are *what for*. A phase is finished when
its goal's red test goes red on the old code and green on the new.

### G1 — a question is answered in hours, not weeks

| | |
|---|---|
| Measure | median time to the first human reply on a `needs_info` park |
| Baseline | 360 h median, and **zero** human comments across all 17 parked issues — measured 2026-08-27, `autonomous-session-pooling.md` |
| Target | under 4 h, and at least one reply on every park |
| Red test | park an agent-filed issue with **no assignee**, then assert a human recipient is notified *and* the issue shows in an attention bucket. `recipient = assigneeId ?? createdById` (`notifications/notify-transitions.ts`) and the `assigneeId` predicate on the awaiting-input query (`me/attention-routes.ts`) are where it lands |
| Consumes | A1 — two edits, not one: the notify set **and** the attention bucket. Landed 2026-08-29 |
| Duplex | needs none of it; ship this first, on its own |

Resolve-on-answer follows the `strandedResolutionKey` precedent, not `HEALTHY_STATUSES`: any move off
`needs_info` IS the human answering, which is the argument `cm:why ISS-762` already makes for
`waiting`. `answer-resume.ts` moves the issue to `AUTONOMOUS_ENTRY_STATUS` (`open`), which is not a
healthy status and never will be — so a `PROBLEM_STATUSES` key gated on health would never clear.

### G2 — every ceiling counts processes, not turns

| | |
|---|---|
| Measure | what each bound actually bounds once a process outlives its work |
| Baseline | `chat_max_concurrent` = 3 (`config.rs#default_chat_max_concurrent`) bounds **turns** — `_permit` is a local dropped when `run_turn` returns. Nothing under `packages/runner/crates/` names eviction, residency or checkpoint: 0 hits, 2026-08-29. `sessionResidencySeconds` has exactly one occurrence in the repo, its own declaration in `pipeline-config-schema.ts` — no reader |
| Target | the semaphore refuses the 4th resident **process**; `sessionResidencySeconds` has a reader; the runner can end residency unilaterally, checkpoint-first, and reports the reason |
| Red test | hold 3 idle resident sessions and send a 4th `work` — passes today, which is the defect; must be refused after |
| Consumes | phase 1 — the permit, the chat idle window and the release event are one deliverable, and phase 1 is where the object they bound first exists (A3 as a separate pre-phase is withdrawn) |
| Priced | `chat_max_concurrent` stays 3 — nothing in the runner prices memory. The amnesty ends when a reader for `sessionResidencySeconds` and an eviction path both exist |
| Blocks | every duplex phase |

### G3 — no state lies about progress

| | |
|---|---|
| Measure | `VISION: state-never-lies` on the session axis |
| Baseline | `daemon/dispatch.rs#consume` beats a synthetic `progress` every 25 s whenever nothing else posted; core turns any job-event batch into a `lastHeartbeatAt` bump (`jobs/events-routes.ts`), which the 3-min heartbeat hop reads (`jobs/loop-monitor.ts`) |
| Target | `runtimeState` is the only progress claim; a parked session bumps nothing and is bounded by residency, not by a beat |
| Red test | park a duplex session past the heartbeat window — if it still reports healthy while nothing is progressing, red |
| Consumes | phase 2's events, plus the beat deletion that phase 3 carries |

### G4 — one session model on the whole fleet

| | |
|---|---|
| Measure | grep |
| Baseline | `-p` (`runner/claude_code.rs#build_args`), the `Stdio::null()` stdin, `RESULT_EXIT_GRACE`, the one-shot `Outcome` derivation, the `sessionMode` key |
| Target | zero hits; `print` unreachable |
| Red test | after the config migration, a stored config still carrying `sessionMode` fails validation — and not one release before it |
| Consumes | phases 1, 3, 4, 5, 6 |

### G5 — a transient failure costs a turn, not the job

| | |
|---|---|
| Measure | drive jobs that lose all progress to a transient failure |
| Baseline | 84 of 195 drive jobs failed over 90 days (43 %), `transient-cc` 48 — measured 2026-08-27, same source |
| Target | a `transient-cc` costs one turn |
| Owner | **unassigned.** This document's own closing line says it "is not addressed anywhere here", and no phase claims it. Durable `session_inbox` + `checkpoint` are the only mechanism that could make it true. Assign it or name where it lives — 84 jobs is not a footnote |

### Not a goal

- **Pooling** — several jobs sharing one session. Closed by measurement, see the withdrawn proposal.
  Reopens only if G1 shows parks answered in *minutes*.
- **A concurrency cap above 1** — VISION parks it behind kernel trust. It is not an answer to capacity.
- **Thinking vs wedged** — needs a semantic progress signal; cheaper and separate (see Not in scope).

## Decisions taken

| # | Was open | Decided |
|---|---|---|
| 1 | which turn's `num_turns` decides `no_work` (ISS-626) | **cumulative at session close**, not the first result. A session that asks at turn 1 and works at turn 2 is not no-work; reading the first turn flags the happy path this RFC creates. Measured 2026-08-29: the CLI reports `num_turns` **per turn** (every `result` carried 1), so there is no cumulative number to read — core sums it. And a slash command is itself a turn, so `num_turns > 0` is not by itself evidence of work |
| 2 | does `spec.timeout_seconds` cover the residency wait | **no.** Timeout measures working, residency measures waiting for a human. Merged, raising residency silently shortens every job's work budget and a long park dies of timeout with nothing wrong |
| 3 | is `sessionMode` the end state | **no** — migration device, deleted in phase 6 |
| 4 | what replaces `inflight.rs`'s reattach guarantee | nothing needs to: see below. Prerequisite is A2 |

## The hazard replacement was supposed to introduce, and why it nets the other way

`Stdio::piped()` (replacing `claude_code.rs`'s `Stdio::null()`) means the daemon holds the only
write end, so an involuntary daemon exit EOFs the child. `inflight.rs`'s module header is built on
the opposite — *"the agent child is `setsid`-detached so it survives a daemon restart"*. Measured
against the three ways this daemon actually exits:

| Daemon exits because | Today | After replacement |
|---|---|---|
| auto-update | re-checks `inflight == 0` and **defers** if busy (`daemon/mod.rs#run`, the update loop) — never kills a job | unchanged |
| credential rotation | drains 30 min then `exit(0)` **unconditionally** (`daemon/mod.rs#run`, the credential-watch loop), with no re-check — **kills a busy job today** | fixed in A2: both paths now share `drain_to_idle`, which returns whether the daemon is idle, and the credential path stops exiting when it is not. The ceiling stays a ceiling — under residency `inflight != 0` will include a session parked on a human, so turning it into a wait-forever (what mirroring the update path's *defer* would mean) never applies the new token. Making the park drainable is phase 3's |
| crash / OOM / `systemctl stop` | child survives and keeps writing git — the two-agents-one-worktree race `inflight.rs` exists to patch | child gets EOF and ends after its turn |

So replacement **removes** a hazard class. The only regression is that an involuntary exit no longer
leaves a working agent behind, and that was never a feature — it is the condition ISS-862 was filed
about. `inflight.rs` is not deleted: its question (*is there a survivor?*) gets easier to answer
truthfully, and `not_found`-is-a-fact still needs a marker.

**Measured, `claude` 2.1.251, 2026-08-29.** EOF does not cut a turn: stdin closed 400 ms into a
20-line generation still produced the complete `result` and then `exit 0`. Two turns ran on one
process, and the process stayed alive between them. So the assumption the whole phase rests on is no
longer an assumption.

## Phases

Each lands green on `pnpm verify` + `cargo test` and is useful alone. The **Deletes** column is what
this plan adds over the RFC's build order.

| # | Lands | Deletes | Gate |
|---|---|---|---|
| **0** | substrate (`0190`) · durable send, `session_inbox`, classifier v9 (`0191`) | — | done — `f98fe7ce`, `1c597208` |
| **A1** | done — the park notifies (`notifications/notify-transitions.ts`) and reaches the bucket (`me/attention-routes.ts`). NOT via `PROBLEM_STATUSES`: that key is per-ISSUE and shared with `reopen`/`waiting`, so the park carries its own `issue:<id>:question` key, resolved on any move OFF `needs_info` — the `strandedResolutionKey` shape (`cm:why ISS-762`), because the answer lands on `open`, which is not healthy | — | `attention-question-park-e2e.test.ts` |
| **A2** | done — one `drain_to_idle` for both restart paths (`daemon/mod.rs`), and the credential path now honours its answer instead of exiting regardless. The park half is NOT here: nothing writes `runtimeState` yet, so no session can park and there is nothing to make drainable — it lands with phase 3, named in a `cm:guard` on the helper | the credential path's private copy of the drain loop, which is where the bug lived | `cargo test`; **blocks every piped-stdin phase** |
| **A3** | **withdrawn as a separate phase — folded into phase 1.** Verified 2026-08-29: under one-shot nothing outlives a turn. `ClaudeCodeRunner`'s `sessions` map is inserted on spawn and removed when the process exits, so session lifetime *is* turn lifetime and a session-scoped permit is not merely arithmetically identical to the turn-scoped one — it has no object to be scoped to. Written now it would be a refactor with no assertion that can fail | — | — |
| **1** | duplex spawn + inverted completion task, **chat only**: `Stdio::piped()`, `--input-format stream-json`, `--replay-user-messages`, `--session-id`; prompt moves off `-p` into a `work` message; `send` stops returning `NotImplemented` (`claude_code.rs`). **Plus what A3 was:** the session-scoped permit, the chat idle window that closes an abandoned session, and `--resume` rehydrate on the next turn — the same change, because this phase creates the first object that outlives a turn and therefore the first release event a permit can wait on | chat's per-turn one-shot lane — `chat.rs`'s module header, `resume_id` on `Turn` / `handle_start` / `handle_send` / `run_turn`, and the two `cm:guard`s in `handle_send` and `run_turn` that exist **only** because a follow-up respawns. **Neither rule dies with its guard.** The model picker must still be honoured per turn — measured 2026-08-29, an in-band `/model sonnet` on a live stream-json session emits a fresh `system:init` and the next turn's `modelUsage` carries the new model, so the picker becomes a `/model` message and needs no respawn lane. The refresh rule has no such answer yet: `refresh::refresh` runs once per spawn in `run_turn`, and a resident session that answers every few minutes would never refresh — the opposite of what the 28h-stale-checkout guard was written for. Phase 1 must name where refresh happens | chat end-to-end; no pipeline job touched |
| **2** | `TurnEnded` + `StateChanged` events · core classifies turn end · loop-monitor quiet reads `runtimeState` | — | verify + integration |
| **3** | pipeline jobs on duplex · `answer` + ack-is-commit in `answer-resume.ts` · durable core-side residency deadline | the 25 s synthetic `progress` beat (`daemon/dispatch.rs#consume`) — a session that declares its state does not need a beat asserting one | one project on forge-beta |
| **4** | `inject` · `checkpoint` · `cancel` folded into the `job.cancel` key space | `abort`'s signal path (`claude_code.rs`) → becomes checkpoint-then-close | verify + live |
| **5** | default flips to duplex; `print` reachable only by explicit opt-out, one release | — | fleet-wide, measured |
| **6** | `sessionMode` and `print` removed | `RESULT_EXIT_GRACE` (`claude_code.rs`), the one-shot `Outcome` derivation (`result_seen` / per-job `num_turns` / `succeeded` / `result_error`), the `Stdio::null()` spawn path, the `sessionMode` config key | verify |

### `kind='result'` gates phase 3, not phase 6

`loop-monitor.ts#reapSessionLostJobs` and `#reapResultMisses` both require
`NOT EXISTS (… kind = 'result')`. A duplex job that finishes turn 1 has a `result` row and is
therefore **permanently immune to `reapResultMisses`, for any cause**. That edit ships with phase
3 — the phase that first puts a pipeline job on duplex — not with the cleanup.

### The beat dies with the flip, not before it

Same argument as `kind='result'`, other direction. The beat feeds `lastHeartbeatAt` through
`jobs/events-routes.ts`, and the 3-min heartbeat hop in `jobs/loop-monitor.ts` reaps on it; ISS-285
added it for exactly the long silent steps a print job has — docker build, E2E. Print sessions leave
`runtimeState` NULL, which the schema guard defines as *infer nothing*. So deleting the beat while
any pipeline job is still print reaps live jobs after three minutes of silence. It goes with phase 3,
the phase that leaves no print job behind it.

### Phase 6 needs a config migration first

`pipeline-config-schema.ts` is `.strict()`. Deleting `sessionMode` from the schema makes every
stored project config still carrying it **fail validation**. Order: strip the key from
`projects.agent_config` in a migration, then remove it from the schema. Never the reverse.

### The substrate broke the size budget, and it was split rather than re-frozen

Phase 0 grew `packages/core/src/db/schema.ts` past its frozen budget. Resolved 2026-08-29 by moving
`session_inbox` into its own schema module on the `schema-journal.ts` precedent — registered in
`drizzle.config.ts` and the drizzle client's schema map, `db:generate` reports no schema change. No
amnesty was taken, and phases 3-4 now add to a file with headroom.

## Session accounting — the pooling the design does not name

RFC 0003 has a section titled *"No pooling"*. It answers a different question: may several **jobs**
share one session for a warm prefix. No — and the measurement backs it (43 % cache hit, a 1-hour
`ephemeral_1h_input_tokens` TTL against a p50 drive job of 67 minutes, and the one safe mechanism,
in-band `/clear` emitting `conversation_reset`, destroys the warm prefix that was the only prize).
See `docs/proposals/autonomous-session-pooling.md`, withdrawn.

That decision leaves a second question untouched: **a runner box now holds several live Claude
processes at once, arrived at as a consequence rather than a design.** `ClaudeCodeRunner` is one
shared exec path for `daemon/mod.rs`, `daemon/chat.rs` and `daemon/dispatch.rs`, and residency means
a process outlives the work that started it.

| Surface | Bounded today by | Bounded after replacement by |
|---|---|---|
| chat | `chat_max_concurrent` semaphore, default **3** (`config.rs#default_chat_max_concurrent`) — and today that bounds **processes**, because a turn's process spawns and exits inside `run_turn`, so turn count and process count are the same number | the same semaphore, still per-turn: `_permit` is a local dropped when `run_turn` returns (`chat.rs`). The process stays. **Turns stay bounded at 3; live processes become unbounded — one per open chat** |
| pipeline job | `RUNNER_CAP_PER_RUNNER = 1` (`dispatch-gates.ts`), process exits at the end of the job | cap 1 still, but a **parked** session holds the slot — RFC 0003 §Slot accounting: *"`working` and `awaiting_input` both hold a slot"*, so **the residency bound is the slot bound**. Correct at the default `0`; above it, the first unanswered question takes the project's throughput to zero (live: forge-dev 7 parks against cap 3) |

### Consequence: chat is not the safe first phase without A3

The plan's phase 1 put chat first on the RFC's reasoning — no residency window needed, no pipeline
blast radius. That reasoning is exactly backwards on this axis. Pipeline session count is bounded at
1 **by construction**; chat is the only surface where the count is set by how many conversations
people happen to open. Phase 1 as written is the phase with the *unbounded* blast radius, and it is
the one scheduled first.

The fix is not to reorder. Pipeline-first would make the first duplex code to run the code that also
touches `kind='result'` in both reaper queries, the completion task and `RUNNER_CAP_PER_RUNNER` —
trading a bounded accounting gap for an unbounded correctness surface. Chat-first exists precisely to
exercise `send` where none of that is live.

Nor can the accounting land *ahead* of it, which is what A3 tried to do. A2 could ship early because
the thing it fixes — a restart path that exits while busy — is a defect the code has **today**. The
permit is not: verified 2026-08-29, `ClaudeCodeRunner`'s `sessions` map is inserted on spawn and
removed when the process exits, so under one-shot a session's lifetime *is* a turn's, and a
session-scoped permit has no object to be scoped to. It would be a refactor whose test cannot fail.
So the permit, the idle window and the release event ship **with** phase 1, which is the change that
first makes a process outlive the work that started it.

### What has to land with it

1. **The permit becomes session-scoped, not turn-scoped.** Acquire when a session is created, release
   when it closes. Without this the semaphore stops measuring anything that exists. It cannot land
   before the duplex spawn: today nothing outlives a turn for it to be scoped to.
2. **Chat gets an idle window of its own — and it is the same mechanism as item 1.** Verified
   2026-08-27: nothing ever closes a chat session. `chat-turn.ts` never writes a terminal
   `agent_sessions.status`, so a conversation sits at `idle`/`running` for good. The permit therefore
   has no release event until the idle window invents one; the two are one mechanism, not two.
   RFC 0003 gives residency to pipeline sessions only; chat has no such concept because it never
   needed one. An idle chat session must `checkpoint` and close,
   rehydrating through the CLI's `--resume` on the next turn — the cold path kept load-bearing,
   exactly as the pipeline design does it. This costs nothing where it matters: an *active*
   conversation stays warm and stops paying 7.5 s a turn, an abandoned one stops holding a process.
3. **The bound stays a count, and the idle window carries the safety.** Three resident processes
   each holding a conversation context is not the footprint of three that spawn and exit, and the
   default of 3 was chosen for the second shape. But nothing in `packages/runner/crates/` prices
   memory at all — no `sysinfo`, no `MemAvailable` read (verified 2026-08-27) — so a memory-derived
   budget would be a number invented here. Keep 3; let eviction, not arithmetic, hold the ceiling.

The eviction *mechanism* exists in the design only — RFC 0003 §Ownership: *"the runner may end
residency unilaterally — upgrade, drain, reboot, OOM — but must `checkpoint` first and must report
the reason."* Nothing under `packages/runner/crates/` names eviction, residency or checkpoint (0
hits, 2026-08-29) and `sessionResidencySeconds` has no reader, so what is missing is both the code
and the **accounting**: who counts a resident session, against what budget, and what happens at the
limit.

## Lockstep

| Moves with | What |
|---|---|
| phase 2 | `jobs/loop-monitor.ts` quiet computation reads `runtimeState` |
| phase 3 | `forge-drive/SKILL.md` *"then end your session"* → *"then finish your turn"*. Never earlier: under `print` waiting really is a lie |
| phase 1 | the spawn path in `forge-runner-core/src/runner/claude_code.rs` |
| phase 6 | this document and `duplex-architecture.html`'s residency-default callout — both currently describe `sessionMode` as permanent |

## Not in scope

- **Thinking vs wedged.** `runtimeState` splits waiting from working, but `working`
  alone does not tell a stuck agent from a busy one. Distinguishing them needs a progress signal with
  semantics. `progress-signal.ts` (`LAST_PHASE_CTE` → `LAST_PROGRESS_AT`) already folds
  `phase_journal` into the quiet clock as a **timestamp**; making it semantic
  (*same phase for N minutes*) is a separate, cheaper piece of work that needs no runner change.
- **Pooling.** Foreclosed by the queueing rule, not by convention.
- **A human who disagrees with a policy-decided question.** Their comment lands on an issue that
  never parked, so `answer-resume.ts` never sees it. `forge-drive/SKILL.md` makes the next session
  honour it; that is a lever, not a mechanism.
- **How often a job fails, and who is told a question is waiting.** A1 covers the second. The
  architecture doc's own closing line applies: this is a capability, not a remedy for either.
