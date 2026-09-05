/**
 * A master agent taking one job, and the kernel recording that it did.
 *
 * The routing decision is the master's and is not re-litigated here. What this
 * owns is the part that must hold when the master is gone: one holder per job,
 * one in-flight step per issue, and a hold that is given back on every path
 * that fails after it lands.
 *
 * Taking and starting are TWO acts (ISS-919 B2). `prepareJobForMaster` mints
 * the token and builds the work while the job stays `queued` and HELD;
 * `startJobForMaster` is the stamp, and the stamp is what ends the hold. A
 * master that prepares and never starts is covered by the release rule that
 * already existed — `releaseJobFromMaster`, or the three-minute reaper — which
 * is the whole reason the split lands on this side of the stamp rather than
 * after it.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { endJobForBudgetBreach } from '../jobs/budget-breach.js';
import { checkMonthlyBudget, shouldEmitWarn } from '../jobs/budget-check.js';
import { mintJobToken } from '../jobs/job-token.js';
import {
  canNameItsAgent,
  type PreparedJob,
  prepareClaimedJob,
  resolveRunnerForDevice,
} from '../jobs/prepare-claimed-job.js';
import { hooks } from '../pipeline/hooks.js';

export type PrepareResult =
  | {
      ok: true;
      jobId: string;
      jobToken: string;
      issueKey: string | null;
      prepared: PreparedJob;
    }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'already_held'
        | 'issue_busy'
        | 'budget_exhausted'
        | 'hold_lost'
        | 'runner_too_old';
    };

export type StartResult = { ok: true } | { ok: false; reason: 'hold_lost' | 'runner_too_old' };

/**
 * Take one queued job for `sessionId` on `deviceId` and build the work, WITHOUT
 * starting anything.
 *
 * Refuses when another step for the same issue is already in flight, and when
 * a job was taken by whoever asked first. On success the job is still `queued`
 * and now HELD: the caller owes either a `startJobForMaster` or a release.
 */
// cm:guard how MANY jobs this box may hold is deliberately NOT decided here — the master weighs `GET /me/load` and the runner refuses on physical fullness (RAM, permit, repo lock), neither of which core can see. Do not reintroduce a device count: a ceiling in the kernel is the knob this design removed, and a master that meets one stops weighing the facts.
// cm:guard L1 — one issue, one in-flight job, whatever the TYPE. `jobs_active_unique` is on (issue_id, type) and so permits a `code` and a `review` job for one issue at once; this NOT EXISTS is the only thing left standing between that and two agents writing the same worktree. It MUST stay inside the UPDATE's WHERE so the check and the hold are one statement — read separately, two masters both see a clear issue.
// cm:guard a refusal here is NOT a job failure and must never touch `attempts` or `failure_kind`. A busy issue and a lost race are the ordinary case, and spending a retry on either burns an issue's budget on something that was never wrong.
export async function prepareJobForMaster(args: {
  jobId: string;
  deviceId: string;
  sessionId: string;
}): Promise<PrepareResult> {
  // cm:guard a version skew is a REFUSAL, not an error, and it is checked before the hold so there is nothing to give back. Throwing instead would reach the master as a bare 500 with the reason nowhere — this route's own rule is that a refused claim answers 200 with `ok:false`, and an operator whose box has gone quiet reads that reason in the master's transcript. Like every other refusal it must not be retried in a loop: only updating the runner clears it.
  if (!(await canNameItsAgent(args.deviceId))) {
    return { ok: false, reason: 'runner_too_old' };
  }

  // cm:guard the token is minted AFTER this transaction commits, never inside it. `mintJobToken` writes through the module-level `db` rather than the passed `tx`, so a mint placed inside would survive a rollback — a live credential for a job whose hold never landed, with nothing left pointing at it to revoke.
  const claimed = await db.transaction(async (tx) => {
    const held = await tx
      .update(jobs)
      .set({ heldBy: args.sessionId, heldAt: sql`now()` })
      .where(
        and(
          eq(jobs.id, args.jobId),
          eq(jobs.status, 'queued'),
          isNull(jobs.heldBy),
          // cm:guard write `jobs.issue_id` / `jobs.id` LITERALLY, never as `${jobs.issueId}`. Drizzle renders a column reference inside a raw `sql` template UNQUALIFIED, so `issue_id` would resolve against the subquery's own `other` row — a NOT EXISTS comparing a row to itself, always true, and L1 silently gone.
          sql`NOT EXISTS (
            SELECT 1 FROM jobs other
            WHERE other.issue_id = jobs.issue_id
              AND other.id <> jobs.id
              AND other.status IN ('dispatched','running','held')
          )`,
        ),
      )
      .returning();

    const row = held[0];
    // cm:guard name the refusal the master can ACT on. `issue_busy` means come back for this job later; `already_held` means another master has it and this one never will. Collapsing them into one reason is how a master learns to treat both as "pick something else" and quietly stops working an issue nothing is wrong with.
    if (!row) {
      // cm:guard do NOT filter this diagnosis to `status = 'queued'`. The claim stamps a job `dispatched`, so the commonest reason to land here is that another master already took it — and a queued-only lookup finds nothing and answers `not_found`, telling a master the job does not exist when it is running one box over.
      const diag = (await tx.execute(sql`
        SELECT j.held_by IS NOT NULL OR j.status <> 'queued' AS taken,
               EXISTS (SELECT 1 FROM jobs o
                       WHERE o.issue_id = j.issue_id AND o.id <> j.id
                         AND o.status IN ('dispatched','running','held')) AS busy
        FROM jobs j WHERE j.id = ${args.jobId} LIMIT 1
      `)) as unknown as Array<Record<string, unknown>>;
      const d = diag[0];
      if (!d) return { kind: 'not_found' } as const;
      return { kind: d.taken ? 'already_held' : 'issue_busy' } as const;
    }

    const keyRows = row.issueId
      ? ((await tx.execute(sql`
          SELECT i.iss_seq FROM issues i WHERE i.id = ${row.issueId} LIMIT 1
        `)) as unknown as Array<Record<string, unknown>>)
      : [];

    return {
      kind: 'held',
      job: row,
      issSeq: (keyRows[0]?.iss_seq as number | null) ?? null,
    } as const;
  });

  if (claimed.kind !== 'held') return { ok: false, reason: claimed.kind };

  const jobToken = await mintJobToken({
    id: claimed.job.id,
    projectId: claimed.job.projectId,
    createdBy: claimed.job.createdBy,
  });
  // cm:guard a mint that fails MUST give the hold back before returning. Leaving it set would park the job on a master that never received a credential for it, and only the 3-minute reaper would notice — a slot lost to a failure that was visible right here.
  if (!jobToken) {
    await releaseJobFromMaster({ jobId: claimed.job.id, sessionId: args.sessionId });
    return { ok: false, reason: 'not_found' };
  }

  // cm:guard the breach ENDS the job (ISS-823 shape: terminal + a `held` retry), it does not merely refuse it. The reason returned here is for the master's next choice; the rows `endJobForBudgetBreach` writes are the kernel's record, and leaving the job `queued` instead would have the next master claim it and post the same comment again.
  const budget = await checkMonthlyBudget(claimed.job);
  if (budget.action === 'pause') {
    await releaseJobFromMaster({ jobId: claimed.job.id, sessionId: args.sessionId });
    await endJobForBudgetBreach(claimed.job, budget);
    return { ok: false, reason: 'budget_exhausted' };
  }
  if (
    budget.action === 'warn-80' &&
    budget.stageStatus !== null &&
    shouldEmitWarn(claimed.job.projectId, budget.stageStatus)
  ) {
    await hooks.emit('pipeline.budgetWarning', {
      projectId: claimed.job.projectId,
      stageStatus: budget.stageStatus,
      jobType: claimed.job.type,
      spent: budget.spent,
      budget: budget.budget ?? 0,
      pct: budget.budget && budget.budget > 0 ? budget.spent / budget.budget : 0,
    });
  }

  // cm:guard a preparation that throws MUST give the hold back, for the same reason a failed mint does: the job would otherwise sit claimed by a master that never received the work, reachable only by the 3-minute reaper.
  let prepared: PreparedJob;
  try {
    prepared = await prepareClaimedJob({ jobId: claimed.job.id, deviceId: args.deviceId });
  } catch (err) {
    await releaseJobFromMaster({ jobId: claimed.job.id, sessionId: args.sessionId });
    throw err;
  }

  return {
    ok: true,
    jobId: claimed.job.id,
    jobToken,
    issueKey: claimed.issSeq == null ? null : `ISS-${claimed.issSeq}`,
    prepared,
  };
}

/**
 * The second act: hand the prepared job over to the process about to run it.
 *
 * Called when the runner has a session for the job and is committed to
 * spawning it. Until this lands the job is plain `queued` and held, which is
 * the state every existing release path already knows how to undo.
 */
// cm:guard THE HANDOVER, and it must be all four columns. The runner's own routes gate on `jobs.device_id` (lifecycle-routes, events-routes, turn-verdict-routes all 403 without it) and ack additionally requires `status IN ('dispatched','running')`, so a start that stamps neither leaves a process core will not talk to: measured live 2026-09-05, two jobs ran on the right repos and every ack and event came back 403. The old `claimRunnerSlot` stamped exactly these four; the pool path owes the same.
// cm:guard the stamp ENDS the hold, in the same statement, and that is what makes the ISS-919 split safe: everything between `prepareJobForMaster` and here is a plain held `queued` job, so a master that dies mid-preparation is recovered by `releaseJobFromMaster` and the three-minute reaper with no stamp to unwind. Leaving the hold set is what let the reaper unwind a stamp out from under a live agent: measured on epodsystem 2026-09-05, jobs f7f4bce4 and 8b8b7be4 sat `queued` with `device_id` NULL while their agents posted events at 2/s, every one 403, forever.
// cm:guard `runnerId` is re-derived HERE rather than carried from the preparation, because the preparation crossed a process boundary and a caller-supplied runner id is a caller asserting which box owns the job. `resolveRunnerForDevice` is the same lookup `prepareClaimedJob` used, so the two cannot disagree.
export async function startJobForMaster(args: {
  jobId: string;
  deviceId: string;
  sessionId: string;
}): Promise<StartResult> {
  if (!(await canNameItsAgent(args.deviceId))) {
    return { ok: false, reason: 'runner_too_old' };
  }
  const [job] = await db
    .select({ projectId: jobs.projectId })
    .from(jobs)
    .where(and(eq(jobs.id, args.jobId), eq(jobs.heldBy, args.sessionId)))
    .limit(1);
  // cm:guard a job this session does not hold is `hold_lost`, never an error. The reaper taking a preparation back mid-spawn is an ordinary outcome the runner answers by dropping the spawn; raising instead would reach the master as a 500 with the reason nowhere.
  if (!job) return { ok: false, reason: 'hold_lost' };
  const runner = await resolveRunnerForDevice(job.projectId, args.deviceId);

  const stamped = await db
    .update(jobs)
    .set({
      status: 'dispatched',
      deviceId: args.deviceId,
      runnerId: runner.id,
      dispatchedAt: new Date(),
      heldBy: null,
      heldAt: null,
    })
    .where(and(eq(jobs.id, args.jobId), eq(jobs.status, 'queued'), eq(jobs.heldBy, args.sessionId)))
    .returning({ id: jobs.id });
  // cm:guard a lost hold here means the reaper took the job back between the two acts. Refuse rather than stamping anyway: another master may already hold it, and two boxes stamped onto one job is the state nothing downstream can untangle.
  if (!stamped.length) {
    await releaseJobFromMaster({ jobId: args.jobId, sessionId: args.sessionId });
    return { ok: false, reason: 'hold_lost' };
  }
  return { ok: true };
}

/** Give a held job back to the pool. */
// cm:guard release NEVER makes a job look failed — it goes back to being claimable, not back to being retried, so `attempts` and the failure columns stay untouched. And it drops the hold ALONE: a held job is always still `queued`, because the stamp that leaves `queued` clears the hold in the same statement, so there is no dispatch stamp here left to undo. Re-adding one would let this path unwind a stamp belonging to a job that has been running for an hour.
export async function releaseJobFromMaster(args: {
  jobId: string;
  sessionId: string;
}): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ heldBy: null, heldAt: null })
    .where(and(eq(jobs.id, args.jobId), eq(jobs.heldBy, args.sessionId)))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Release every job a dead master was holding.
 *
 * Only the hold moves. Anything this master actually started is no longer
 * held at all, so a running job is not reachable from here.
 */
// cm:edge lockstep -> packages/core/src/devices/master-reaper.ts — the third path that drops a hold, and like the other two it drops the hold ALONE. Adding a stamp unwind to any one of them re-opens the epodsystem wedge: a running agent's job re-queued underneath it, reachable by no route it can talk to.
// cm:guard THE load-bearing link of the whole design. Without it a master that dies at 3am leaves its jobs unclaimable forever, and nothing reports why — the exact silent wedge `VISION: state-never-lies` calls a kernel bug. It is called from the runner when the local socket drops and from the session reaper when the heartbeat stops; both paths must stay, because a box that loses power never drops a socket.
export async function releaseAllHeldBySession(sessionId: string): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ heldBy: null, heldAt: null })
    .where(eq(jobs.heldBy, sessionId))
    .returning({ id: jobs.id });
  return rows.length;
}
