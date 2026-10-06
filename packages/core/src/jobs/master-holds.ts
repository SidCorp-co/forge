import { JOB_MACHINE } from '@forge/contracts/job-machine';
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { jobs, terminalAgentSessionStatuses } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { transition } from '../lifecycle/index.js';
import { pushJobChanged } from './job-push.js';

type JobRow = typeof jobs.$inferSelect;

const TERMINAL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

/** Why a hold or a stamp did not land, by name: the claim door turns each into its pool code. */
export type HoldRefusal =
  | { ok: false; reason: 'not_found' | 'already_held' | 'issue_busy' | 'hold_lost' }
  | { ok: false; reason: 'run_paused' | 'run_not_running'; runStatus: string };

/**
 * The status of the run a job belongs to, its row share-locked for the rest of the transaction so
 * the run cannot pause or close between this read and the write; null for a job with no run row.
 */
async function lockedRunStatus(tx: Tx, jobId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT pr.status FROM pipeline_runs pr
    JOIN jobs j ON j.pipeline_run_id = pr.id
    WHERE j.id = ${jobId}
    FOR SHARE OF pr
  `)) as unknown as Array<{ status: string }>;
  return rows[0]?.status ?? null;
}

function runRefusal(runStatus: string | null): HoldRefusal | null {
  if (runStatus === null || runStatus === 'running') return null;
  return {
    ok: false,
    reason: runStatus === 'paused' ? 'run_paused' : 'run_not_running',
    runStatus,
  };
}

/**
 * A master session takes a queued job off the pool: only while nobody holds it, no other job of
 * its issue is under way, and its run, share-locked for the caller's transaction, is `running` (a
 * paused run dispatches nothing). Every refusal names why.
 */
export async function holdQueuedJob(
  tx: Tx,
  jobId: string,
  sessionId: string,
): Promise<{ ok: true; job: JobRow } | HoldRefusal> {
  const refused = runRefusal(await lockedRunStatus(tx, jobId));
  if (refused) return refused;
  const [row] = await tx
    .update(jobs)
    .set({ heldBy: sessionId, heldAt: sql`now()` })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, 'queued'),
        isNull(jobs.heldBy),
        sql`NOT EXISTS (
          SELECT 1 FROM jobs other
          WHERE other.issue_id = jobs.issue_id
            AND other.id <> jobs.id
            AND other.status IN ('dispatched','held')
        )`,
      ),
    )
    .returning();
  if (row) return { ok: true, job: row };
  const [state] = (await tx.execute(sql`
    SELECT j.held_by IS NOT NULL OR j.status <> 'queued' AS taken FROM jobs j WHERE j.id = ${jobId}
  `)) as unknown as Array<{ taken: boolean }>;
  if (!state) return { ok: false, reason: 'not_found' };
  return { ok: false, reason: state.taken ? 'already_held' : 'issue_busy' };
}

/**
 * The stamp that ends a hold: the held job moves to `dispatched` on the box about to run it, its
 * run share-locked and read in the same transaction, and its readers are told in that transaction.
 */
export async function dispatchHeldJob(args: {
  jobId: string;
  sessionId: string;
  deviceId: string;
  runnerId: string;
}): Promise<{ ok: true } | HoldRefusal> {
  return db.transaction(async (tx) => {
    const refused = runRefusal(await lockedRunStatus(tx, args.jobId));
    if (refused) return refused;
    const { rows } = await transition(tx, JOB_MACHINE, {
      to: 'dispatched',
      from: 'queued',
      set: {
        deviceId: args.deviceId,
        runnerId: args.runnerId,
        dispatchedAt: new Date(),
        heldBy: null,
        heldAt: null,
      },
      where: and(eq(jobs.id, args.jobId), eq(jobs.heldBy, args.sessionId)),
      actor: { type: 'runner', id: args.deviceId },
      source: 'claim',
      returning: ['id', 'projectId', 'deviceId', 'agentSessionId'],
    });
    const [job] = rows;
    if (!job) return { ok: false, reason: 'hold_lost' };
    await pushJobChanged(
      job,
      'job.dispatched',
      { jobId: job.id, projectId: job.projectId, status: 'dispatched' },
      tx,
    );
    return { ok: true };
  });
}

/**
 * Give one held job back, if `sessionId` still holds it, in its own
 * transaction with the run share-locked: a job whose run still takes work goes back to the pool;
 * one whose run is over is settled `cancelled`, never re-queued under a closed run.
 */
export async function releaseJobHold(jobId: string, sessionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const runStatus = await lockedRunStatus(tx, jobId);
    const held = and(eq(jobs.id, jobId), eq(jobs.heldBy, sessionId));
    if (runStatus === null || runStatus === 'running' || runStatus === 'paused') {
      const rows = await tx
        .update(jobs)
        .set({ heldBy: null, heldAt: null })
        .where(held)
        .returning({ id: jobs.id });
      return rows.length > 0;
    }
    const { rows } = await transition(tx, JOB_MACHINE, {
      to: 'cancelled',
      from: 'queued',
      set: { heldBy: null, heldAt: null, finishedAt: new Date() },
      where: held,
      reason: `run ${runStatus}: a hold under a closed run is settled, not given back`,
      actor: { type: 'system' },
      source: 'hold-release',
      returning: ['id'],
    });
    return rows.length > 0;
  });
}

/** Give back one released hold, logging (never swallowing) a row that could not be settled. */
async function releaseOne(jobId: string, sessionId: string): Promise<boolean> {
  try {
    return await releaseJobHold(jobId, sessionId);
  } catch (err) {
    logger.error({ err, jobId }, 'master-holds: a hold could not be given back; the rest continue');
    return false;
  }
}

/**
 * Give back every job one session holds, one row per transaction so one row never fails the rest.
 * Only the hold moves: a job its master started is no longer held at all.
 */
export async function releaseHoldsOf(sessionId: string): Promise<number> {
  const held = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.heldBy, sessionId));
  let released = 0;
  for (const { id } of held) if (await releaseOne(id, sessionId)) released += 1;
  return released;
}

/**
 * Release the holds of master sessions that are terminal or silent, with each former holder.
 * `silent` is the reaper's own predicate over a session alias (`devices/master-silence.ts`), so a
 * silent master whose child is still beating keeps its holds exactly as the reaper keeps it, and
 * the run standing's hold clock reads the same beat; a terminal one does not. A hold whose master
 * has no row is released once it is `staleSeconds` old.
 */
export async function releaseHoldsOfDeadMasters(
  silent: (alias: string) => SQL,
  staleSeconds: number,
): Promise<Array<{ jobId: string; formerHolder: string; masterStatus: string }>> {
  const doomed = (await db.execute(sql`
    SELECT j.id, j.held_by, COALESCE(s.status, 'no_session') AS master_status
    FROM jobs j
    LEFT JOIN agent_sessions s ON s.id = j.held_by
    WHERE j.held_by IS NOT NULL
      AND (
        s.status IN (${TERMINAL})
        OR (s.id IS NOT NULL AND ${silent('s')})
        OR (s.id IS NULL AND j.held_at < now() - make_interval(secs => ${staleSeconds}))
      )
  `)) as unknown as Array<{ id: string; held_by: string; master_status: string }>;
  const released: Array<{ jobId: string; formerHolder: string; masterStatus: string }> = [];
  for (const r of doomed) {
    if (await releaseOne(r.id, r.held_by)) {
      released.push({ jobId: r.id, formerHolder: r.held_by, masterStatus: r.master_status });
    }
  }
  return released;
}
