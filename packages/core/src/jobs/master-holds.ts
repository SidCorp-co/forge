import { JOB_MACHINE } from '@forge/contracts/job-machine';
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { jobs, terminalAgentSessionStatuses } from '../db/schema.js';
import { transition } from '../lifecycle/index.js';

type JobRow = typeof jobs.$inferSelect;

const TERMINAL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

/**
 * A master session takes a queued job off the pool: only while nobody holds it, no other job of
 * its issue is under way, and its run is `running` (a paused run dispatches nothing). Null when
 * it could not be taken.
 */
export async function holdQueuedJob(
  tx: Tx,
  jobId: string,
  sessionId: string,
): Promise<JobRow | null> {
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
            AND other.status IN ('dispatched','running','held')
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM pipeline_runs r WHERE r.id = jobs.pipeline_run_id AND r.status <> 'running'
        )`,
      ),
    )
    .returning();
  return row ?? null;
}

/** The stamp that ends a hold: the held job moves to `dispatched` on the box about to run it. */
export async function dispatchHeldJob(args: {
  jobId: string;
  sessionId: string;
  deviceId: string;
  runnerId: string;
}): Promise<boolean> {
  const { rows } = await transition(db, JOB_MACHINE, {
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
    returning: ['id'],
  });
  return rows.length > 0;
}

/** Give one held job back to the pool, if this session still holds it. */
export async function releaseJobHold(jobId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ heldBy: null, heldAt: null })
    .where(and(eq(jobs.id, jobId), eq(jobs.heldBy, sessionId)))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Give back every job one session holds. Only the hold moves: a job its master started is no
 * longer held at all.
 */
export async function releaseHoldsOf(sessionId: string): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ heldBy: null, heldAt: null })
    .where(eq(jobs.heldBy, sessionId))
    .returning({ id: jobs.id });
  return rows.length;
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
  const rows = (await db.execute(sql`
    WITH doomed AS (
      SELECT j.id, j.held_by,
             COALESCE(s.status, 'no_session') AS master_status
      FROM jobs j
      LEFT JOIN agent_sessions s ON s.id = j.held_by
      WHERE j.held_by IS NOT NULL
        AND (
          s.status IN (${TERMINAL})
          OR (s.id IS NOT NULL AND ${silent('s')})
          OR (s.id IS NULL AND j.held_at < now() - make_interval(secs => ${staleSeconds}))
        )
    )
    UPDATE jobs
    SET held_by = NULL, held_at = NULL
    WHERE id IN (SELECT id FROM doomed)
    RETURNING id, (SELECT held_by FROM doomed d WHERE d.id = jobs.id) AS former_holder,
              (SELECT master_status FROM doomed d WHERE d.id = jobs.id) AS master_status
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    jobId: String(r.id),
    formerHolder: String(r.former_holder),
    masterStatus: String(r.master_status),
  }));
}
