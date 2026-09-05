# `failover` names an intent the pool cannot carry out

**Status:** found 2026-09-06 by the review of ISS-920, in the change that introduced the cause.
Reported rather than filed, because closing it means teaching a master to route on box capacity —
which the issue itself puts out of scope, and which is not a lock-scoping change's to make.

## What the code does

ISS-920 gives a spawn that exhausts the box's duplex permits its own failure text, and core
classifies it `kind: 'infra'`, `action: 'failover'`, `cause: 'box_session_saturated'`. `failover`
reads as "send the next attempt somewhere else". On the push dispatcher it means that:
`resume-policy.ts` sets `pinDeviceId = autoRetry.target` and selection honours it.

On the pool path — how this project's jobs are actually claimed — it means nothing:

- `readPool` (`devices/pool.ts`) selects on `status`, `held_by`, `retry_after_at`, the run's
  status and the sibling-job exclusion. Its own `cm:guard` forbids adding a routing filter, on the
  grounds that routing is the master's judgement and a pool that pre-decides it is the kernel
  deciding routing again. So `_autoRetry.target` is never consulted, and the box that just refused
  the job may claim the clone.
- `nextRotation` (`jobs/retry.ts`) only returns `defer` when `online.length === 0`. A saturated box
  is online and capable, so `notifyCapacityOutage` never fires. On a one-box project there is no
  record anywhere that the fleet ran out of permits.
- Worse before it is better: `immediateFailover` sets `cooldownMs = 0`, so the clone is claimable
  at once — where the pre-ISS-920 `repo_lock_timeout` verdict was `retry` and paid
  `RETRY_COOLDOWN_MS` (60s). For the pool path the new action is a *faster* re-claim.

## Why ISS-920 shipped it anyway

Because the diagnosis is worth having on its own. Before it, these jobs died `repo_lock_timeout`,
matched no rule, and landed `unclassified` + `needsReview`; the operator saw a lock error naming
their own repo while the actual fault was a box-level ceiling another project had filled. A named
cause on the job row is B3's "distinguishable, by whoever re-claims, from a job that merely lost a
race". It is not B3's "must not spin", and ISS-920's comment says so rather than implying the
stronger thing.

## What closing this would take

One of:

1. **A capacity signal in the pool.** `pool load` reports `jobsRunning` and `reposLocked` and no
   permit figure at all, so no master can route around a full box even if it wanted to. Adding one
   is the smallest honest step and it is master-orchestration work.
2. **Make `immediateFailover` conditional on the target being enforceable.** One line in
   `retry.ts`, but it changes the cooldown for every failover cause on every project, and there is
   no way to prove that safe from inside one issue.
3. **Let the runner refuse the re-claim.** A box that just answered `session_permit_saturated`
   knows it is full; declining the claim locally is the only lever that needs no core change.

Nothing here is a defect in ISS-920's diff. It is the gap between what `failover` says and what the
pool does, which existed before this cause and now has one more caller relying on it.

## Honest costs

| Choice | What it costs whoever adopts it |
|---|---|
| 1 — a permit figure in `pool load` | The pool's innocence. `readPool`'s guard exists because a pool that pre-decides routing is the kernel deciding routing again. A reading is harmless; the moment a master acts on it, "which box is too full" is a judgement somebody owns, and they own defending that boundary against the next filter someone wants in there. |
| 2 — conditional `immediateFailover` | Every failover cause on every project, to fix one. It is not scoped to `box_session_saturated`, so it moves retry timing for provider outages, spend caps and usage limits across ~20 tenant projects at once, with no staging fleet to measure on. A wrong guess does not fail loudly — it shifts retries by 60s where nobody is watching. |
| 3 — the runner declines claims while full | The box's ability to be wrong out loud. A box that refuses quietly stops looking full to anyone: the pool stays deep, the master sees work it cannot place, and the symptom moves from a named failure to a project going silent — the failure mode this issue exists to remove. |
| 0 — leave it | A faster spin than before ISS-920 on exactly these boxes: `cooldownMs = 0` where `repo_lock_timeout` paid 60s. This is the price being paid today, in exchange for a job row that names its own cause. |

## Also found, and not fixed here

`refresh_is_repairable` (`daemon/dispatch.rs`) can never return true: its `owns_root` argument is a
hardcoded `false` at the only call site, so the `findings.push` behind it is unreachable and the
setup-agent capability it gated is dead. Deleting it is a judgement about whether that capability
should come back — which belongs to the lane that lost it, not to a lock-scoping change. Its test
(`for owns_root in [true, false]`) keeps the predicate honest for whoever revives it.
