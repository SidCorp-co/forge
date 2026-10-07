import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';

const LIVE = sql.join(
  LIVE_PIPELINE_RUN_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * True where the row's claim is held by a release run that ended without shipping: a failed or
 * aborted run that recorded a deploy keeps its roster claimed at the release step for a person
 * (`releaseEndedRunClaims`), because its code may be live. `claimer` is the claim column to read.
 */
export function heldByEndedRelease(claimer: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM pipeline_runs r
     WHERE r.id = ${claimer}
       AND r.status NOT IN (${LIVE})
       AND r.release_released_at IS NULL
  )`;
}

/** The rows of a project at its release gate still claimed by a release that ended unshipped. */
export async function heldByEndedReleaseIds(
  projectId: string,
  gateStatus: string,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM issues
     WHERE project_id = ${projectId}
       AND status = ${gateStatus}
       AND release_batch_run_id IS NOT NULL
       AND ${heldByEndedRelease(sql`issues.release_batch_run_id`)}
     ORDER BY merged_at ASC NULLS LAST, id ASC
  `);
  return rows.map((r) => r.id);
}

/**
 * A release run claims the named issues of a project waiting at its gate, only where no other run
 * holds them. Answers the ids it claimed; the caller decides what a short claim means.
 */
export async function claimIssuesForRelease(args: {
  projectId: string;
  issueIds: readonly string[];
  gateStatus: string;
  runId: string;
  /**
   * Also take a row whose claim a release that ended unshipped still holds (`heldByEndedRelease`).
   * Only the release that verifiably shipped the row's commit asks this; `heldBy` answers the run
   * the row was taken from, so a row it does not close goes back to it.
   */
  fromEndedRelease?: boolean;
}): Promise<Array<{ id: string; heldBy: string | null }>> {
  if (args.issueIds.length === 0) return [];
  const free = args.fromEndedRelease
    ? sql`(release_batch_run_id IS NULL OR ${heldByEndedRelease(sql`release_batch_run_id`)})`
    : sql`release_batch_run_id IS NULL`;
  const claimed = await db.execute<{ id: string; heldBy: string | null }>(sql`
    WITH taken AS (
      SELECT id, release_batch_run_id AS held_by FROM issues
       WHERE project_id = ${args.projectId}
         AND id IN (${sql.join(
           args.issueIds.map((id) => sql`${id}`),
           sql`, `,
         )})
         AND status = ${args.gateStatus}
         AND ${free}
       FOR UPDATE
    )
    UPDATE issues
    SET release_batch_run_id = ${args.runId}, updated_at = now()
    FROM taken
    WHERE issues.id = taken.id
    RETURNING issues.id, taken.held_by AS "heldBy"
  `);
  return [...claimed];
}

/**
 * Hand each row `runId` took from an ended release back to it, where it did not close: the claim
 * and its release step are what keep that roster held for a person.
 */
export async function returnTakenClaims(
  tx: Tx,
  runId: string,
  taken: ReadonlyArray<{ id: string; heldBy: string }>,
): Promise<string[]> {
  const returned: string[] = [];
  for (const row of taken) {
    const back = await tx.execute<{ id: string }>(sql`
      UPDATE issues SET release_batch_run_id = ${row.heldBy}, updated_at = now()
       WHERE id = ${row.id} AND release_batch_run_id = ${runId} AND status <> 'closed'
      RETURNING id
    `);
    returned.push(...[...back].map((r) => r.id));
  }
  return returned;
}

/**
 * Every claim one release run holds is let go, or only those on `only` where named; answers the
 * rows it let go with their status.
 */
export async function releaseRunClaims(
  runId: string,
  tx: Tx = db,
  only?: readonly string[],
): Promise<Array<{ id: string; status: string }>> {
  if (only?.length === 0) return [];
  const scoped = only
    ? sql`AND id IN (${sql.join(
        only.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const rows = await tx.execute<{ id: string; status: string }>(sql`
    UPDATE issues SET release_batch_run_id = NULL, updated_at = now()
    WHERE release_batch_run_id = ${runId} ${scoped}
    RETURNING id, status
  `);
  return [...rows];
}

/**
 * Clear the claims of release runs that ended, so their issues can join another batch. A roster
 * whose run recorded a production deploy and is still held at its release step stays claimed: a person
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
          AND r.status NOT IN (${LIVE})
      )
      AND NOT (
        issues.status = 'awaiting_release'
        AND EXISTS (SELECT 1 FROM issue_work_state w WHERE w.issue_id = issues.id AND w.step = 'release')
        AND EXISTS (
          SELECT 1 FROM release_attempts a
          WHERE a.run_id = issues.release_batch_run_id AND a.stage = 'deploy'
        )
      )
    RETURNING id
  `);
  return (released as unknown as unknown[]).length;
}
