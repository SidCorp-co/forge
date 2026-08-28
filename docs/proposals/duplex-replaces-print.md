# Duplex replaces print mode — full plan to a fleet with one session model

Scope: RFC 0003 shipped as a **replacement**, not a permanent per-project flag. Ends with
`sessionMode` deleted, `print` gone, and the one-shot lanes that exist only to serve it removed.

Companion: `docs/proposals/duplex-architecture.html` (drawn). Where it describes `sessionMode` as
the end state, this document supersedes it: it is a migration device with a scheduled deletion.
RFC 0003, which held the design, was deleted in the 2026-08-28 docs cleanup — this document and the
drawing are what remain of it.

## Decisions taken

| # | Was open | Decided |
|---|---|---|
| 1 | which turn's `num_turns` decides `no_work` (ISS-626) | **cumulative at session close**, not the first result. A session that asks at turn 1 and works at turn 2 is not no-work; reading the first turn flags the happy path this RFC creates |
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
| credential rotation | drains 30 min then `exit(0)` **unconditionally** (`daemon/mod.rs#run`, the credential-watch loop), with no re-check — **kills a busy job today** | fixed in A2: mirror the update path's re-check |
| crash / OOM / `systemctl stop` | child survives and keeps writing git — the two-agents-one-worktree race `inflight.rs` exists to patch | child gets EOF and ends after its turn |

So replacement **removes** a hazard class. The only regression is that an involuntary exit no longer
leaves a working agent behind, and that was never a feature — it is the condition ISS-862 was filed
about. `inflight.rs` is not deleted: its question (*is there a survivor?*) gets easier to answer
truthfully, and `not_found`-is-a-fact still needs a marker. Confirm the EOF-ends-after-turn
behaviour empirically in phase 1 before relying on it.

## Phases

Each lands green on `pnpm verify` + `cargo test` and is useful alone. The **Deletes** column is what
this plan adds over the RFC's build order.

| # | Lands | Deletes | Gate |
|---|---|---|---|
| **0** | substrate (`0190`) · durable send, `session_inbox`, classifier v9 (`0191`) | — | done — `f98fe7ce`, `1c597208` |
| **A1** | `needs_info` into `NOTIFY_ON_STATUS` **and** `PROBLEM_STATUSES` (`notifications/notify-transitions.ts`) | — | unit |
| **A2** | credential-watch path re-checks idle before `exit(0)` (`daemon/mod.rs#run`, the credential-watch loop) | — | `cargo test`; **blocks every piped-stdin phase** |
| **A3** | chat's concurrency permit becomes **session-scoped**: acquired when a session is created, released when it closes; a chat idle window is the close signal. `chat_max_concurrent` stays 3 | — | `cargo test`; a no-op under one-shot, **blocks phase 1** |
| **1** | duplex spawn + inverted completion task, **chat only**: `Stdio::piped()`, `--input-format stream-json`, `--replay-user-messages`, `--session-id`; prompt moves off `-p` into a `work` message; `send` stops returning `NotImplemented` (`claude_code.rs`) | chat's per-turn one-shot lane — `chat.rs`'s module header, `resume_id` on `Turn` / `handle_start` / `handle_send` / `run_turn`, and the two `cm:guard`s in `handle_send` and `run_turn` that exist **only** because a follow-up respawns | chat end-to-end; no pipeline job touched |
| **2** | `TurnEnded` + `StateChanged` events · core classifies turn end · loop-monitor quiet reads `runtimeState` | the 25 s synthetic `progress` beat (`daemon/dispatch.rs#consume`) — a session that declares its state does not need a beat asserting one | verify + integration |
| **3** | pipeline jobs on duplex · `answer` + ack-is-commit in `answer-resume.ts` · durable core-side residency deadline | — | one project on forge-beta |
| **4** | `inject` · `checkpoint` · `cancel` folded into the `job.cancel` key space | `abort`'s signal path (`claude_code.rs`) → becomes checkpoint-then-close | verify + live |
| **5** | default flips to duplex; `print` reachable only by explicit opt-out, one release | — | fleet-wide, measured |
| **6** | `sessionMode` and `print` removed | `RESULT_EXIT_GRACE` (`claude_code.rs`), the one-shot `Outcome` derivation (`result_seen` / per-job `num_turns` / `succeeded` / `result_error`), the `Stdio::null()` spawn path, the `sessionMode` config key | verify |

### `kind='result'` gates phase 3, not phase 6

`loop-monitor.ts#reapSessionLostJobs` and `#reapResultMisses` both require
`NOT EXISTS (… kind = 'result')`. A duplex job that finishes turn 1 has a `result` row and is
therefore **permanently immune to `reapResultMisses`, for any cause**. That edit ships with phase
3 — the phase that first puts a pipeline job on duplex — not with the cleanup.

### Phase 6 needs a config migration first

`pipeline-config-schema.ts` is `.strict()`. Deleting `sessionMode` from the schema makes every
stored project config still carrying it **fail validation**. Order: strip the key from
`projects.agent_config` in a migration, then remove it from the schema. Never the reverse.

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
exercise `send` where none of that is live. So the accounting lands **first, as A3**, on the same
pattern as A2: behaviour-preserving today, load-bearing the moment residency exists. A session-scoped
permit is arithmetically identical to a turn-scoped one while a session's lifetime IS a turn's, which
is why it can ship green before any duplex code.

### What has to land with it

1. **The permit becomes session-scoped, not turn-scoped.** Acquire when a session is created, release
   when it closes. Without this the semaphore stops measuring anything that exists.
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

The eviction *mechanism* already exists in the design — RFC 0003 §Ownership: *"the runner may end
residency unilaterally — upgrade, drain, reboot, OOM — but must `checkpoint` first and must report
the reason."* What is missing is the **accounting**: who counts a resident session, against what
budget, and what happens at the limit.

## Lockstep

| Moves with | What |
|---|---|
| phase 2 | `jobs/loop-monitor.ts` quiet computation reads `runtimeState` |
| phase 3 | `forge-drive/SKILL.md` *"then end your session"* → *"then finish your turn"*. Never earlier: under `print` waiting really is a lie |
| phase 1 | the spawn path in `forge-runner-core/src/runner/claude_code.rs` |
| phase 6 | this document and `duplex-architecture.html`'s residency-default callout — both currently describe `sessionMode` as permanent |

## Not in scope

- **Thinking vs wedged.** `runtimeState` splits waiting from working; the beat still fires
  throughout `working`. Distinguishing a stuck agent from a busy one needs a progress signal with
  semantics. `progress-signal.ts` (`LAST_PHASE_CTE` → `LAST_PROGRESS_AT`) already folds
  `phase_journal` into the quiet clock as a **timestamp**; making it semantic
  (*same phase for N minutes*) is a separate, cheaper piece of work that needs no runner change.
- **Pooling.** Foreclosed by the queueing rule, not by convention.
- **A human who disagrees with a policy-decided question.** Their comment lands on an issue that
  never parked, so `answer-resume.ts` never sees it. `forge-drive/SKILL.md` makes the next session
  honour it; that is a lever, not a mechanism.
- **How often a job fails, and who is told a question is waiting.** A1 covers the second. The
  architecture doc's own closing line applies: this is a capability, not a remedy for either.
