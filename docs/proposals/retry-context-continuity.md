# Retry context continuity

Status: **L1, L2 and L3 shipped** (`da2a2189` core, `948d50f6` runner) · L4 open · Verified against
the tree 2026-08-26

L1 reaches a runner only on its next release; core has always treated `salvage` as optional, so a
fleet that lags reports failures exactly as it did before.

A job that fails and retries starts its Claude conversation from zero. Nothing carries the previous
attempt's reasoning, and nothing carries its uncommitted code. This proposal closes both, in four
layers that ship independently.

## What is actually lost, measured

ISS-862 on forge-dev, live while this was written. Three attempts, three sessions:

| Attempt | Session | `claude_session_id` | Messages | Runner | Outcome |
|---|---|---|---|---|---|
| 1 | `c24da1c2` | `8e69c7cf` | **645** | dev1 CLI | failed — org spend limit |
| 2 | `efd0cb64` | `436b9ea7` | 4 | ubuntu3 | failed — org spend limit |
| 3 | `087d34bc` | `558c376c` | 264 | dev1 CLI | running |

Message counts are not monotonic (645 → 4 → 264), which is the proof they are three independent
conversations rather than one continued. ISS-812 shows the same shape across four attempts
(869 / 4 / 1031 / 93), all chained to `rootSessionId = a632e694`.

`issues.session_context` for ISS-862 is **NULL** — 645 messages of work produced no durable record,
because `session_context` is written by the agent at step end and attempt 1 never reached one.

### The three deliberate decisions that produce this

None of these is a bug. Each is load-bearing, which is why the fix is additive rather than a revert.

| Where | Decision |
|---|---|
| `jobs/retry.ts:473` | `cm:guard` — *never carry `agentSessionId` onto the clone*. Copying it would short-circuit `ensureAgentSessionForJob` and overwrite the reaped attempt's transcript (ISS-434 / ISS-785) |
| `jobs/dispatcher.ts:418-423` | `if (isRetry) { … priorClaudeSessionId = null }` — *"Rotation moves devices on purpose → never resume a prior session"* |
| `jobs/session-resume.ts:143` | `findPriorSessionInGroup` filters `status = 'completed'`, so a `failed` session can never be resumed |

`ensureAgentSessionForJob` (`jobs/agent-session-link.ts:150-175`) inserts the new session with
`metadata` lineage (`attempt`, `retryOfJobId`, `retryOfSessionId`, `rootSessionId`) and
`pipelineHealth`, and copies neither `messages` nor `claudeSessionId`. Lineage is for traceability;
it carries no content.

### What already survives

| Survives | Why |
|---|---|
| Commits already pushed to the `ISS-*` branch | git, independent of the session |
| Comments the failed attempt posted | on the issue, re-read by the next prompt |
| `pipelineHealth` (recovery stats, auto-retry counts) | copied forward deliberately |
| The failed session's full transcript | **still in `agent_sessions.messages`** — nothing reads it |

That last row is the cheapest opportunity in this document. The data is not gone; it is unreferenced.

---

## L1 — Salvage the working copy when a job fails

**The layer the owner asked for.** A failed `code`/`fix` job leaves uncommitted edits in its
worktree. The next attempt cuts a fresh checkout and never sees them.

The commit must happen **runner-side**. Core has no working copy, and the agent that would have
committed is the thing that died. The runner already has every part needed:

| Need | Already present |
|---|---|
| git invocation | `workspace/worktree.rs:15`, `daemon/preflight.rs:118`, `workspace/worktree_reap.rs:33` |
| push credentials | `auth/git_cred.rs` (`write_git_credential`) |
| push, proven | `workspace/worktree_reap.rs:138,147` |
| the job's worktree path | **found, not derived** — see the correction below |

### Correction, measured 2026-08-26

The path above is wrong, and shipping it as written would have been a fleet-wide no-op. Core has
**never** sent `worktreeBranch` (grep: the field appears only in the runner and in one doc line), so
`worktree::create` is dead code. On dev1, `<repo>/.worktrees/` did not exist at all, while six
worktrees sat under `.claude/worktrees/` — the agent's own convention, one of them ISS-862's.

Salvage therefore **finds** the checkout: `git worktree list --porcelain` from the repo root,
excluding the root itself and the base branch, narrowed to branches matching the job's `ISS-<seq>`.
Core sends that key on `job.assigned`; without it the runner declines rather than guessing, because
a real box carries stale dirty worktrees from other issues (two on dev1, dirty since 2026-08-12 —
the reaper spares a dirty worktree by design).

### Hook point

`daemon/dispatch.rs:581-600`, immediately **before** `lifecycle::fail`, on both terminal arms:

```rust
match terminal {
    Some(Terminal::Done(code)) => { /* unchanged */ }
    Some(Terminal::Failed(err)) => {
        let salvage = salvage_wip(&worktree, &branch, job_id).await;   // NEW
        lifecycle::fail_with_salvage(client, job_id, &err, salvage).await
    }
    None => {
        let salvage = salvage_wip(&worktree, &branch, job_id).await;   // NEW
        lifecycle::fail_with_salvage(client, job_id, "runner ended without a result", salvage).await
    }
}
```

The `None` arm matters as much as the `Failed` arm — a runner that dies mid-stream is exactly the
case where uncommitted work is largest.

### Rules the salvage must obey

Each of these is a way the naive version does damage.

| # | Rule | Why |
|---|---|---|
| 1 | Only inside the job's own worktree, only on the job's own `ISS-*` branch | A salvage push to `main` or to a base branch is an unreviewed commit on a protected ref |
| 2 | Refuse if `HEAD` is detached, or the branch does not match the job's expected branch | A reprovision or a stale worktree can leave the checkout somewhere else |
| 3 | No empty commit — `git status --porcelain` empty → do nothing, report `none` | An empty salvage commit per failed attempt is noise on every branch |
| 4 | `git add -A` only; never `-f` | `.gitignore` is the only thing standing between a salvage and a committed `.env`. Overriding it is how a secret ships |
| 5 | Hard timeout (suggest 20s total) and fully best-effort | Salvage must never delay or replace `lifecycle::fail`. A job whose failure is never reported is worse than a lost diff |
| 6 | Push failure is a reported outcome, not an error | The branch may have moved, the network may be the reason the job failed at all |
| 7 | Commit message is machine-readable and marked | Review and the next agent both need to distinguish salvage from authored work |

### Commit message

```
wip(salvage): ISS-862 attempt 1 failed — uncommitted work preserved

forge-salvage: true
forge-job-id: <job uuid>
forge-attempt: 1
forge-failure: [RESULT_ERROR] success: You've hit your org's monthly spend limit
```

Trailers rather than prose so `git log --grep='forge-salvage: true'` is exact, and so a review step
can refuse to treat a salvage commit as a deliverable.

### What L1 does not cover

Salvage runs on the terminal events the runner's own `consume` loop observes. A **core-side reap** —
`reapAckMisses` / `reapResultMisses` (quiet threshold 60 min) / `reapSessionLostJobs` in
`jobs/loop-monitor.ts` — fails and retries a job without the runner reporting anything, so `consume`
never reaches a terminal arm and no salvage happens.

That is ISS-862's own shape: attempt 4 hung at `release.deploy.in_flight` and was reaped, not
failed. L2 still carries the transcript pointer for a reaped attempt, because core writes the
failure; only the working copy is lost. Closing the reaped class needs a different mechanism (core
asking the runner to salvage before it reaps) and is not in this proposal.

### Contract change

`POST /api/jobs/:id/fail` currently accepts `{ error }` only (`jobs/lifecycle-routes.ts:434-465`,
`failBodySchema`). It gains an optional `salvage`:

```jsonc
{
  "error": "…",
  "salvage": {
    "outcome": "pushed" | "committed_not_pushed" | "none" | "refused" | "failed",
    "branch": "ISS-862-runner-health",
    "sha": "a1b2c3d…",
    "files": 7,
    "insertions": 214,
    "detail": "…"          // only on refused/failed
  }
}
```

Optional, so an older runner keeps working — the runner fleet upgrades independently of core
(`docs/architecture/runner-daemon.md`). Persist it on the job (`jobs.failure_meta` already exists
and is the right home) so L2 can read it without a second table.

`outcome` distinguishes the five real cases; collapsing them to a boolean is what makes
"why is there no salvage?" unanswerable later.

---

## L2 — Tell the retry what the previous attempt did

Core-side, no Rust, no migration. The highest value per line in this document.

**The tool already exists.** `prompt/user.ts:251` (`ADDRESS_OPEN_ITEMS_BLOCK`) already instructs
agents:

> Need context the handoff does not carry? Re-query the prior stage's session (max 3 calls this
> step): `forge_agent_sessions.list({ projectId, issueId })` → pick the prior stage's session (match
> `pipelineRunId`) → `forge_agent_sessions.get({ sessionId })` (returns the last-20 message tail
> only).

Two reasons it does not fire on a retry: it says *prior **stage***, not *prior **attempt***, and it
only renders when a prior handoff exists. So the retry agent is never told that a failed sibling
session exists, let alone its id.

### The block to add

Rendered **only** when `job.retryOf != null`, from data core already holds
(`metadata.retryOfSessionId`, `jobs.failure_meta`, `jobs.attempts`):

```
## Previous attempt failed — read it before you start

This is attempt 3. Attempt 2 failed: org/account spend limit.

- Its transcript: `forge_agent_sessions.get({ sessionId: 'efd0cb64-…' })` — last-20 tail.
  Attempt 1 (`c24da1c2-…`, 645 messages) also failed; read it too if the tail is thin.
- Its uncommitted work was salvaged to `ISS-862-runner-health` as `a1b2c3d`
  (7 files, +214). Start from that commit; it is WIP, not reviewed work.
- Do NOT redo work those attempts completed. Verify, then continue.
```

Three properties worth stating:

- **A pointer, not an inlining.** `description` is capped at
  `DEFAULT_FIELD_CAPS.description = 8000` (`prompt/user.ts:84`) and truncated before the agent sees
  it. Pasting a transcript evicts the requirements — the same trap the `writing-an-issue` guide
  names for HTML.
- **It names the salvage sha**, which is what makes L1 usable rather than merely present. L1 without
  L2 produces commits nobody is told about.
- **Retry chain, not just the parent.** `metadata.rootSessionId` already resolves the whole chain to
  one root, so listing every prior attempt is a query core can already answer.

### Optional hardening

If prompt-layer guidance proves too soft (the memory note *handoff = best-effort context* says it
usually is), have `finalizeFailedJob` (`jobs/finalize-failure.ts:216`) snapshot a short
machine-written digest — last assistant message, files touched, last tool call — into
`session_context` or `failure_meta`. Then continuity does not depend on the next agent choosing to
make a tool call. Prefer this only after measuring whether L2's pointer is followed; a snapshot
core writes is one more thing that can go stale.

---

## L3 — Resume the CLI session when the retry stays on the same box

There is a safe resume window today that is thrown away.

`nextRotation` rule 1 (`jobs/retry.ts:164`) keeps the **same** device while
`tries < RETRY_TRIES_PER_DEVICE` (`= 3`, `retry.ts:59`):

```rust
if (ranOn && target === ranOn && tries < RETRY_TRIES_PER_DEVICE) {
  return { kind: 'rotate', state: { target: ranOn, tries: tries + 1, … } };
}
```

When that branch is taken the session file is still on that box — but
`dispatcher.ts:418` nulls `priorClaudeSessionId` for **every** retry regardless.

### The change

Null the resume only when the rotation actually changes device:

```ts
if (isRetry) {
  skipPrimary = true;
  excludeDeviceIds = autoRetry.done;
  pinDeviceId = autoRetry.target;
  const sameBox = autoRetry.target != null && autoRetry.target === job.deviceId;
  const resumable = sameBox && job.failureAction === 'retry';
  if (!resumable) priorClaudeSessionId = null;
}
```

`findPriorSessionInGroup` cannot supply the id (it requires `status='completed'`), so the resume
target is the parent session's `claudeSessionId`, read via `metadata.retryOfSessionId`.

### Scope limit, stated plainly

**This does not cover the failure currently biting.** A spend-limit is classified
`failure_action = 'failover'` (`pipeline/failure-classifier.ts:213-217`), and the failover path
forces `tries: RETRY_TRIES_PER_DEVICE` (`retry.ts:414-416`) precisely so rule 1 cannot fire and the
box is left on the first failure. So L3 covers `infra` / `timeout` retries only. It is worth doing —
those are the common transient shape — but it is not a substitute for L1/L2.

Existing resume knobs are `onResumeFail`, `maxResumeTokens`, `maxResumeReopenCycles`
(`pipeline/pipeline-config-schema.ts:410-419`). There is no `resumeOnRetry`, so this is a genuine
gap rather than an unset option. `onResumeFail: 'fresh'` (default) already handles a stale session
file by nulling it and dispatching fresh, so the failure mode this opens is already covered.

---

## L4 — Hold instead of rotating into exhausted accounts

Not a continuity layer — a waste-prevention one, included because it is what makes the others
observable in practice.

A spend-limit failover rotates to the next device. When every account is capped, every rotation
fails the same way and the rounds burn out to `all_devices_exhausted`. Measured on ISS-862: dev1 →
ubuntu3 → dev1, all three the same `org's monthly spend limit`. Two of four runners carry
`limit_reason = 'usage_limit'` with `rate_limited_until` of 07:49 and 09:40 — and `dev1 · CLI
runner`, which shows no limit flag at all, hit the same wall.

`limit-detect.ts` already parses the reset time out of the error text
(*"your session limit resets 1pm (Asia/Ho_Chi_Minh)"*). Use it: when the classified failure is an
account/org cap and no un-capped device remains, `held` until the earliest reset rather than
spending a rotation round. `nextRotation` rule 0 already has the deferral shape
(`kind: 'defer'`, `CAPACITY_DEFER_CEILING_MS`) — this feeds it a real deadline instead of a ceiling.

This overlaps ISS-862's own scope ("a runner reports healthy while it is not taking work") and
should land there rather than as separate work.

---

## Sequencing

| Order | Layer | Depends on | Surface | State |
|---|---|---|---|---|
| 1 | **L2** | nothing | core prompt only | shipped `da2a2189` |
| 2 | **L1** | L2 for the sha to be read | Rust + `fail` contract + `failure_meta` | shipped `948d50f6` |
| 3 | **L4** | nothing | core classifier/retry | open |
| 4 | **L3** | nothing | core dispatcher | shipped `da2a2189` |

L2 first, deliberately: it is the only layer that works for **every** failure mode, needs no runner
release, and it is what makes L1's commits reachable. L1 before L2 produces salvage commits nobody
is told about; L2 before L1 still recovers the reasoning, which is the larger loss.

L1 needs a runner release to reach the fleet, and the fleet lags (see `forge_runner_release_channel`
in project memory — a failed release run on the tag is the usual cause). Core must therefore treat
`salvage` as absent-by-default forever, not as a field that arrives once runners upgrade.

## Risks

| Risk | Mitigation |
|---|---|
| Salvage commits a secret the agent wrote to disk | Rule 4 — `git add -A`, never `-f`; `.gitignore` is the boundary. A repo whose `.gitignore` does not cover its own secret files has a prior problem |
| Salvage push races core's reap-and-redispatch | Best-effort; a rejected push is reported as `failed`, not retried. The next attempt reads whichever sha did land |
| A review step treats WIP salvage as authored work | `forge-salvage: true` trailer, and the L2 block says *"it is WIP, not reviewed work"* |
| L2's pointer is guidance an agent can ignore | Measure whether it is followed before escalating to the core-written digest under **L2 → Optional hardening** |
| L3 resumes a session corrupted by whatever failed | Gated on `failure_action = 'retry'`; `onResumeFail: 'fresh'` already recovers a bad resume |
| Salvage delays failure reporting | Rule 5 — hard timeout, and `lifecycle::fail` runs regardless of the salvage outcome |

## Rejected

| Alternative | Why not |
|---|---|
| Copy `agentSessionId` onto the retry clone | Directly reverts the `retry.ts:473` guard — overwrites the reaped attempt's transcript, the ISS-434 / ISS-785 defect |
| Let `findPriorSessionInGroup` accept `status='failed'` | Would resume failed sessions across *stages*, not just attempts, and would resume across a device rotation where the session file does not exist |
| Have core commit the working copy | Core has no working copy. Only the runner does |
| Inline the previous transcript into the prompt | `description` is capped at 8000 chars and truncated; a transcript evicts the requirements |
| Keep the runner from rotating on failover | Rotation is why per-account failover works at all; the correct fix for the all-capped case is L4's hold |
