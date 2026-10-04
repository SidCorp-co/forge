import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';

/**
 * A release run claims the named issues of a project waiting at its gate, only where no other run
 * holds them. Answers the ids it claimed; the caller decides what a short claim means.
 */
export async function claimIssuesForRelease(args: {
  projectId: string;
  issueIds: readonly string[];
  gateStatus: string;
  runId: string;
}): Promise<Array<{ id: string }>> {
  if (args.issueIds.length === 0) return [];
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE issues
    SET release_batch_run_id = ${args.runId}, updated_at = now()
    WHERE project_id = ${args.projectId}
      AND id IN (${sql.join(
        args.issueIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND status = ${args.gateStatus}
      AND release_batch_run_id IS NULL
    RETURNING id
  `);
  return [...claimed];
}

/** Every claim one release run holds is let go; answers the rows it let go with their status. */
export async function releaseRunClaims(
  runId: string,
  tx: Tx = db,
): Promise<Array<{ id: string; status: string }>> {
  const rows = await tx.execute<{ id: string; status: string }>(sql`
    UPDATE issues SET release_batch_run_id = NULL, updated_at = now()
    WHERE release_batch_run_id = ${runId}
    RETURNING id, status
  `);
  return [...rows];
}

/**
 * Clear the claims of release runs that ended, so their issues can join another batch. A roster
 * whose run recorded a promotion and is still held at its release step stays claimed: a person
 * settles it, and its claims are the only index a `return-to-gate` abort reads it back by.
 */
export async function releaseEndedRunClaims(): Promise<number> {
  const released = await db.execute<{ id: string }>(sql`
    UPDATE issues
    SET release_batch_run_id = NULL, updated_at = now()
    WHERE release_batch_run_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM pipeline_runs r
        WHERE r.id = issues.release_batch_run_id
          AND r.status NOT IN ('running', 'paused')
      )
      AND NOT (
        issues.status = 'awaiting_release'
        AND EXISTS (SELECT 1 FROM issue_work_state w WHERE w.issue_id = issues.id AND w.step = 'release')
        AND EXISTS (
          SELECT 1 FROM release_attempts a
          WHERE a.run_id = issues.release_batch_run_id AND a.stage = 'promote'
        )
      )
    RETURNING id
  `);
  return Array.isArray(released) ? released.length : 0;
}
