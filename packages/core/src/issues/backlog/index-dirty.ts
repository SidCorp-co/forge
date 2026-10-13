/**
 * The queue of changes the maintained indexes have not caught up with (ISS-1336).
 *
 * Postgres triggers write it (migration 0327), so no application path has to remember to. A drain
 * reads a batch with the generation each row carried and deletes only those generations: a change
 * that arrives while the drain runs bumps the generation and survives, and one that arrives after
 * inserts a fresh row.
 */

import { sql } from 'drizzle-orm';
import { type BacklogIndexKind, WHOLE_PROJECT_SUBJECT } from '../../db/schema-backlog-index.js';
import { type IndexExecutor, rowsOf, textList, uuidArray } from './index-sql.js';

export interface PendingSummary {
  pending: number;
  oldestMarkedAt: Date | null;
}

export interface ClaimedMark {
  kind: BacklogIndexKind;
  subjectId: string;
  generation: number;
}

export const isWholeProject = (mark: Pick<ClaimedMark, 'subjectId'>): boolean =>
  mark.subjectId === WHOLE_PROJECT_SUBJECT;

export async function pendingFor(
  executor: IndexExecutor,
  projectId: string,
  kinds: readonly BacklogIndexKind[],
): Promise<PendingSummary> {
  const [row] = await rowsOf(
    executor,
    sql`SELECT count(*)::int AS pending, min(first_marked_at) AS oldest
          FROM backlog_index_dirty
         WHERE project_id = ${projectId}::uuid AND index_kind IN (${textList(kinds)})`,
  );
  return {
    pending: Number(row?.pending ?? 0),
    oldestMarkedAt: row?.oldest ? new Date(String(row.oldest)) : null,
  };
}

/** Oldest first, so a backlog of marks drains in the order the changes arrived. */
export async function claimMarks(
  executor: IndexExecutor,
  projectId: string,
  kinds: readonly BacklogIndexKind[],
  limit: number,
): Promise<ClaimedMark[]> {
  const rows = await rowsOf(
    executor,
    sql`SELECT index_kind, subject_id::text AS subject_id, generation::int AS generation
          FROM backlog_index_dirty
         WHERE project_id = ${projectId}::uuid AND index_kind IN (${textList(kinds)})
         ORDER BY first_marked_at, subject_id
         LIMIT ${limit}`,
  );
  return rows.map((row) => ({
    kind: String(row.index_kind) as BacklogIndexKind,
    subjectId: String(row.subject_id),
    generation: Number(row.generation),
  }));
}

/** Deletes the marks at the generation that was read; one bumped since stays for the next pass. */
export async function releaseMarks(
  executor: IndexExecutor,
  projectId: string,
  marks: readonly ClaimedMark[],
): Promise<void> {
  if (marks.length === 0) return;
  await executor.execute(sql`
    DELETE FROM backlog_index_dirty d
     USING (VALUES ${sql.join(
       marks.map((one) => sql`(${one.kind}, ${one.subjectId}::uuid, ${one.generation}::bigint)`),
       sql`, `,
     )}) AS m(kind, subject_id, generation)
     WHERE d.project_id = ${projectId}::uuid AND d.index_kind = m.kind
       AND d.subject_id = m.subject_id AND d.generation = m.generation`);
}

/** The same upsert the triggers run, for a change the clock made and no write announced. */
export async function markSubjects(
  executor: IndexExecutor,
  kind: BacklogIndexKind,
  projectId: string,
  subjectIds: readonly string[],
  reason: string,
): Promise<void> {
  if (subjectIds.length === 0) return;
  await executor.execute(sql`
    SELECT backlog_index_mark(${kind}, ${projectId}::uuid, s.id, ${reason})
      FROM unnest(${uuidArray(subjectIds)}) AS s(id)`);
}

/** One drain at a time per index and project: the lock is the transaction's and ends with it. */
export async function tryDrainLock(
  executor: IndexExecutor,
  name: 'rank' | 'alike',
  projectId: string,
): Promise<boolean> {
  const [row] = await rowsOf(
    executor,
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`backlog-index:${name}:${projectId}`}, 0)) AS got`,
  );
  return row?.got === true;
}
