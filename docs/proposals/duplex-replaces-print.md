# Duplex replaces print mode — full plan to a fleet with one session model

Scope: RFC 0003 shipped as a **replacement**, not a permanent per-project flag. Ends with
`sessionMode` deleted, `print` gone, and the one-shot lanes that exist only to serve it removed.

Companions: `docs/rfcs/0003-duplex-agent-session.md` (the design, Revision 2) ·
`docs/proposals/duplex-architecture.html` (drawn). Where those two describe `sessionMode` as the
end state, this document supersedes them: it is a migration device with a scheduled deletion.

## Decisions taken

| # | Was open | Decided |
|---|---|---|
| 1 | which turn's `num_turns` decides `no_work` (ISS-626) | **cumulative at session close**, not the first result. A session that asks at turn 1 and works at turn 2 is not no-work; reading the first turn flags the happy path this RFC creates |
| 2 | does `spec.timeout_seconds` cover the residency wait | **no.** Timeout measures working, residency measures waiting for a human. Merged, raising residency silently shortens every job's work budget and a long park dies of timeout with nothing wrong |
| 3 | is `sessionMode` the end state | **no** — migration device, deleted in phase 6 |
| 4 | what replaces `inflight.rs`'s reattach guarantee | nothing needs to: see below. Prerequisite is A2 |

## The hazard replacement was supposed to introduce, and why it nets the other way

`Stdio::piped()` (replacing `claude_code.rs:451` `Stdio::null()`) means the daemon holds the only
write end, so an involuntary daemon exit EOFs the child. `inflight.rs:1-13` is built on the opposite
— *"the agent child is `setsid`-detached so it survives a daemon restart"*. Measured against the
three ways this daemon actually exits:

| Daemon exits because | Today | After replacement |
|---|---|---|
| auto-update | re-checks `inflight == 0` and **defers** if busy (`daemon/mod.rs:213-215`) — never kills a job | unchanged |
| credential rotation | drains 30 min then `exit(0)` **unconditionally** (`daemon/mod.rs:276-285`), with no re-check — **kills a busy job today** | fixed in A2: mirror the update path's re-check |
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
| **A1** | `needs_info` into `NOTIFY_ON_STATUS` **and** `PROBLEM_STATUSES` (`notifications/notify-transitions.ts:25,37`) | — | unit |
| **A2** | credential-watch path re-checks idle before `exit(0)` (`daemon/mod.rs:276-285`) | — | `cargo test`; **blocks every piped-stdin phase** |
| **1** | duplex spawn + inverted completion task, **chat only**: `Stdio::piped()`, `--input-format stream-json`, `--replay-user-messages`, `--session-id`; prompt moves off `-p` into a `work` message; `send` stops returning `NotImplemented` (`claude_code.rs:821`) | chat's per-turn one-shot lane — `chat.rs:11-13`, `resume_id` at `:104,:250,:293,:369`, and the two `cm:guard`s at `:291`/`:336` that exist **only** because a follow-up respawns | chat end-to-end; no pipeline job touched |
| **2** | `TurnEnded` + `StateChanged` events · core classifies turn end · loop-monitor quiet reads `runtimeState` | the 25 s synthetic `progress` beat (`daemon/dispatch.rs:549-589`) — a session that declares its state does not need a beat asserting one | verify + integration |
| **3** | pipeline jobs on duplex · `answer` + ack-is-commit in `answer-resume.ts` · durable core-side residency deadline | — | one project on forge-beta |
| **4** | `inject` · `checkpoint` · `cancel` folded into the `job.cancel` key space | `abort`'s signal path (`claude_code.rs:826-834`) → becomes checkpoint-then-close | verify + live |
| **5** | default flips to duplex; `print` reachable only by explicit opt-out, one release | — | fleet-wide, measured |
| **6** | `sessionMode` and `print` removed | `RESULT_EXIT_GRACE` (`claude_code.rs:45`), the one-shot `Outcome` derivation (`result_seen` / per-job `num_turns` / `succeeded` / `result_error`), the `Stdio::null()` spawn path, the `sessionMode` config key | verify |

### `kind='result'` gates phase 3, not phase 6

`loop-monitor.ts:617-623` and `:681-686` both require `NOT EXISTS (… kind = 'result')`. A duplex job
that finishes turn 1 has a `result` row and is therefore **permanently immune to
`reapResultMisses`, for any cause**. That edit ships with phase 3 — the phase that first puts a
pipeline job on duplex — not with the cleanup.

### Phase 6 needs a config migration first

`pipeline-config-schema.ts` is `.strict()` (`:194`, `:212`, `:366`). Deleting `sessionMode` from the
schema makes every stored project config still carrying it **fail validation**. Order: strip the key
from `projects.agent_config` in a migration, then remove it from the schema. Never the reverse.

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
| chat | `chat_max_concurrent` semaphore, default **3** (`config.rs:205`) — and today that bounds **processes**, because a turn's process spawns and exits inside `run_turn`, so turn count and process count are the same number | the same semaphore, still per-turn: `_permit` is a local dropped when `run_turn` returns (`chat.rs:325`). The process stays. **Turns stay bounded at 3; live processes become unbounded — one per open chat** |
| pipeline job | `RUNNER_CAP_PER_RUNNER = 1` (`dispatch-gates.ts:142`), process exits at the end of the job | cap 1 still, but a **parked** session holds the slot — RFC 0003 §Slot accounting: *"`working` and `awaiting_input` both hold a slot"*, so **the residency bound is the slot bound**. Correct at the default `0`; above it, the first unanswered question takes the project's throughput to zero (live: forge-dev 7 parks against cap 3) |

### Consequence: chat is not the safe first phase

The plan's phase 1 put chat first on the RFC's reasoning — no residency window needed, no pipeline
blast radius. That reasoning is exactly backwards on this axis. Pipeline session count is bounded at
1 **by construction**; chat is the only surface where the count is set by how many conversations
people happen to open. Phase 1 as written is the phase with the *unbounded* blast radius, and it is
the one scheduled first.

### What has to land with it

1. **The permit becomes session-scoped, not turn-scoped.** Acquire when a session is created, release
   when it closes. Without this the semaphore stops measuring anything that exists.
2. **Chat gets an idle window of its own.** RFC 0003 gives residency to pipeline sessions only; chat
   has no such concept because it never needed one. An idle chat session must `checkpoint` and close,
   rehydrating through the CLI's `--resume` on the next turn — the cold path kept load-bearing,
   exactly as the pipeline design does it. This costs nothing where it matters: an *active*
   conversation stays warm and stops paying 7.5 s a turn, an abandoned one stops holding a process.
3. **A real resource bound, not a count.** Three resident processes each holding a conversation
   context is not the same footprint as three that spawn and exit. The default of 3 was chosen for
   the second shape.

The eviction *mechanism* already exists in the design — RFC 0003 §Ownership: *"the runner may end
residency unilaterally — upgrade, drain, reboot, OOM — but must `checkpoint` first and must report
the reason."* What is missing is the **accounting**: who counts a resident session, against what
budget, and what happens at the limit.

## Lockstep

| Moves with | What |
|---|---|
| phase 2 | `jobs/loop-monitor.ts` quiet computation reads `runtimeState` |
| phase 3 | `forge-drive/SKILL.md` *"then end your session"* → *"then finish your turn"*. Never earlier: under `print` waiting really is a lie |
| phase 1 | `docs/architecture/runner-daemon.md` spawn description |
| phase 6 | this document, `docs/rfcs/0003-duplex-agent-session.md` §Schema, and `duplex-architecture.html`'s residency-default callout — all three currently describe `sessionMode` as permanent |

## Not in scope

- **Thinking vs wedged.** `runtimeState` splits waiting from working; the beat still fires throughout
  `working`. Distinguishing a stuck agent from a busy one needs a progress signal with semantics.
  `progress-signal.ts:16-19` already folds `phase_journal` into the quiet clock as a **timestamp**;
  making it semantic (*same phase for N minutes*) is a separate, cheaper piece of work that needs no
  runner change.
- **Pooling.** Foreclosed by the queueing rule, not by convention.
- **A human who disagrees with a policy-decided question.** Their comment lands on an issue that
  never parked, so `answer-resume.ts` never sees it. `forge-drive/SKILL.md` makes the next session
  honour it; that is a lever, not a mechanism.
- **How often a job fails, and who is told a question is waiting.** A1 covers the second. The
  architecture doc's own closing line applies: this is a capability, not a remedy for either.
