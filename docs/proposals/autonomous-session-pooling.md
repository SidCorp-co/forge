# Autonomous session pooling

- Status: **withdrawn 2026-08-27** — the mechanism is real, but the case for it was priced against the wrong population and rests on two claims that are now refuted. Kept as the record of what was measured; the work it points at is elsewhere.
- Related: [agent-driven pipeline](agent-driven-pipeline.md) · `AUTONOMOUS_DRIVER_STATUSES` (`core/src/pipeline/autonomous-mode.ts`)

## The ask

Replace print mode: the runner spawns a Claude session that waits, and pools jobs to it.

## What is true

`--input-format stream-json` is a long-lived process that reads newline-delimited user messages on
stdin; `--replay-user-messages` echoes each one back as an accepted-ack. Both verified on
`claude` 2.1.247. The runner already passes the output half.

## What was wrong with the first version of this proposal

**1. The refutation of pooling was overstated.** It claimed *"there is no in-band control message to
start a fresh conversation on a live stream-json session"*. That was asserted, not tested. Sending
`/clear` as a user message mid-stream emits a first-class `conversation_reset` protocol event and
the next turn answers `NONE`:

```
→ "Remember the word: ZANZIBAR"        assistant: stored
→ "/clear"                             conversation_reset
→ "What word were you told earlier?"   assistant: NONE
```

So the context-bleed objection collapses. What survives is narrower and process-level: cwd, the
per-issue worktree, env, and `FORGE_VERDICT_FILE` persist across `/clear`, so a pool serving
different repos still has a real problem. Pooling within one repo is not refuted by this evidence.

**2. The cache argument was measured wrong.** It ran the *same* prompt twice. Production never does:
every drive job carries a different issue preamble via `--append-system-prompt`, which breaks the
cache prefix. Re-measured with differing appended prompts: ~19k of ~45k tokens hit cache (43%) and
25,700 are re-created per job — and the usage payload reports `ephemeral_1h_input_tokens`, a **1-hour
TTL** against a p50 drive job of 67 minutes. Consecutive jobs routinely find it expired. *"The
session is already warm"* is false.

**3. The 758 hours belong to a different population.** Per status, on autonomous projects:

| status | n | avg h | median h | what it is |
|---|---|---|---|---|
| `on_hold` | 8 | **760** | 338 | `cancelPipelineRun`'s device-actor park, `skip: true` — **no question pending, no session to hold** |
| `needs_info` | 3 | 355 | 360 | real driver questions — the population a held session would serve |
| `waiting` | 6 | 55 | **13** | real driver parks written to a status nothing wakes |

The headline number is the `on_hold` row: cancelled runs where nobody was asked anything. A held
process fixes none of them. And on all 17 parked issues, human comments since the park: **zero**.

**4. It optimises a path drive jobs do not take.** `jobs/resume-policy.ts#resolveResumePolicy` gates
the session-group lookup on `job.type !== AUTONOMOUS_JOB_TYPE`, with a `cm:guard` saying why — a
drive job resumes through `forge_phase resume_point`, never `--resume`. Measured over 90 days: drive
jobs with `resume_failed` = **0**. The `[RESUME_FAILED]` branch this proposal was built around has
never fired for the mode it targets.

## What kills the held-session shape outright

Three findings, any one of them sufficient.

**The answer has nowhere to go.** Held, the drive job stays `running`. `answer-resume` flips the
issue to `open`, `dispatchAutonomous` hits the `jobs_active_unique` partial index (which covers
`running`), and `autonomous-dispatch.ts#dispatchAutonomous`'s `ActiveJobConflictError` catch
**swallows the conflict and returns `true`**. No job, no signal, nothing that knows to write into
the living process's stdin. The design's central promise requires a core→runner answer channel that
does not exist.

**It would make the kernel lie.** `daemon/dispatch.rs#consume` beats a synthetic `progress` event
every `HEARTBEAT_INTERVAL = 25s` whenever no real batch went out. A process idling on stdin
therefore reports itself healthy forever, and `reapResultMisses` (`RESULT_QUIET_MINUTES = 60`) never
fires — every beat asserts progress for something that by definition is not progressing. That is a
`VISION: state-never-lies` violation at any duration. Suppress the beat instead and
`HEARTBEAT_TIMEOUT_MS_DEFAULT = 3 min` fails the session. There is no third option that leaves core
untouched.

**Capacity inverts.** A held job sits in both `running_ids` (project serial gate) and `runner_load`
(per-runner, `RUNNER_CAP_PER_RUNNER = 1`). Today's parks are free, which is *why* several can
coexist. Held, the first unanswered question takes the project's slot and throughput goes to zero
until a human arrives. Live state: forge-dev has **7 parks against a cap of 3**; kinetrak has 1
against a cap of **1**. And VISION parks `concurrency caps >1` behind kernel trust ("Not yet"), so raising the
cap is not an available answer.

`held` (RFC 0002) is not the escape hatch: it is slotless *because nothing is running*, and its
`HOLD_REASONS` guard explicitly refuses business outcomes because doing so "would silently stop
asking a human a question that only a human can answer".

## Blast radius the first version did not name

`ClaudeCodeRunner` is a single shared exec path — `daemon/mod.rs`, `daemon/chat.rs` and
`daemon/dispatch.rs` all go through it, so this touches chat and schedules, not just `drive`. And
the skill-delivery design record (deleted in the 2026-08-28 docs cleanup; recoverable from git
history) had already recorded exactly this change as **"Deferred (high blast radius): switching the
runner's shared `-p` exec path to stream-json + warm-up — pipeline-wide risk."**

## Where the measured defect actually is

Every parked issue has zero human replies, and the reason is an inversion in the notification set.
`notifications/notify-transitions.ts` `NOTIFY_ON_STATUS` = `{tested, reopen, waiting, closed}`:

- **`needs_info` is absent.** The one park `answer-resume.ts` wakes on a comment notifies nobody.
- **`waiting` is present.** The park that never wakes is the one that notifies.

`/me/attention`'s `awaitingInput` bucket further requires `issues.assigneeId = userId`, and MCP
`forge_issues` cannot set an assignee — so an agent-filed issue appears in no bucket at all. A
question is asked on a surface no human reads. 355 hours is what that costs, and a process holding
stdin for a month is an expensive way to wait for a notification nobody sent.

## Recommendation

Withdraw the held-session change. Do these instead, in order:

1. **Fix the notification inversion** — add `needs_info` to `NOTIFY_ON_STATUS`; make the attention
   bucket reachable for an unassigned agent-filed issue. Smallest change, largest measured effect.
2. **Alarm an aged park** — `pipeline/inv7-alarms.ts` already treats a 6-hour hold as a wedge worth
   raising. A `needs_info` sitting 355 hours has no equivalent.
3. **Decide what a cancelled autonomous run's issue is** — the 8 `on_hold` rows are core's own park,
   silent by construction, and on an autonomous project no step serves `on_hold`. That is the same
   argument that earned `reopen → open` a kernel rewrite.
4. **Thicken the checkpoint** — `forge_phase resume_point` returns only `{phase, attempt, startedAt}`
   and `phase_journal` has no read surface. Making a cold start cheap and correct buys what a held
   process buys, survives restarts and device loss, and costs a fraction.

Revisit a warm hold only if a later measurement shows parks answered in **minutes** once notified —
that is the regime it wins in, and today there is no such observation because notification does not
exist for this status.

## Larger finding, out of this proposal's scope

Over 90 days, **84 of 195 drive jobs failed (43%)**, dominated by `transient-cc` (48). That is a much
larger problem than the park and is not addressed anywhere here.

## Honest costs

What withdrawing costs, since the withdrawal is this document's recommendation:

- **The cold start stays.** ~25,700 tokens are re-created per drive job, and the 1-hour cache TTL
  keeps expiring against a 67-minute p50. Nothing here reduces that; the four recommended items make
  a cold start cheap and correct rather than unnecessary.
- **A withdrawn proposal still costs attention.** It stays in the tree only as the record of what was
  measured, and every reader of the index pays a moment deciding it is not open work.
- **The measured defect it uncovered is someone else's issue.** The notification inversion and the
  43% drive-job failure rate are named here and fixed nowhere here — a finding recorded is not a
  finding closed.
