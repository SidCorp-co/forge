/**
 * The nearest issues of every unsettled issue, read from stored rows (ISS-1336).
 *
 * A call makes no embedding call and no search. It catches up what is pending inside a budget,
 * checks that every unsettled issue has a neighbour set measured now, and pages the stored rows.
 * An index that has not measured every issue is refused by name, since a sweep over part of the
 * backlog that reports itself whole is the failure the ISS-1173 stream was filed against.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issueRefFormatter } from '../issue-prefix-read.js';
import { ALIKE_TOP_K, currentMeasuredWith } from './alike-maintainer.js';
import { catchUpAlike } from './index-catch-up.js';
import { pendingFor } from './index-dirty.js';
import {
  type IndexExecutor,
  rowsOf,
  textList,
  UNSETTLED_STATUSES,
  uuidArray,
} from './index-sql.js';
import { BacklogIndexRefused, type IndexState } from './rank-read.js';

export const NEIGHBOURS_LIMIT_MAX = 1_000;
export const NEIGHBOURS_LIMIT_DEFAULT = 500;

export interface NeighbourHit {
  memoryId: string;
  /** The issue the memory row is about; the CLI resolves it against the open issues it holds. */
  sourceRef: string;
  score: number;
  stale: boolean;
}

export interface NeighbourSeed {
  issueId: string;
  displayId: string;
  title: string;
  measuredAt: string;
  /** True where a change to this issue, or to an issue it lists, has not been caught up. */
  stale: boolean;
  hits: NeighbourHit[];
}

export interface NeighboursAnswer {
  seeds: NeighbourSeed[];
  /** Every unsettled issue, all of which are measured when this answer exists. */
  total: number;
  topK: number;
  /** The `after` that continues the read, or null where this page ends it. */
  next: number | null;
  index: IndexState;
}

export interface NeighboursQuery {
  projectId: string;
  topK: number;
  limit: number;
  /** Seeds with an `iss_seq` above this, which is how a page continues. */
  after: number;
  catchUpMs: number;
}

export async function readNeighbours(query: NeighboursQuery): Promise<NeighboursAnswer> {
  const { projectId } = query;
  const measuredWith = await currentMeasuredWith(projectId);
  const caught = await catchUpAlike(projectId, query.catchUpMs, measuredWith);

  const refOf = await issueRefFormatter(projectId);
  // One snapshot for every read below, as for the ranking: a writer committing between the
  // coverage check and the pending count must not be served as an index that was whole and fresh.
  return db.transaction((tx) => answerFrom(tx, query, caught.refusal, refOf), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

async function answerFrom(
  executor: IndexExecutor,
  query: NeighboursQuery,
  catchUpRefusal: string | undefined,
  refOf: (seq: number) => string,
): Promise<NeighboursAnswer> {
  const { projectId } = query;
  // The model is read inside the snapshot too: a change to it between catch-up and the answer is
  // seen as an uncovered index, never as a measurement made under the model it replaced.
  const measuredWith = await currentMeasuredWith(projectId, executor);
  const uncovered = await rowsOf(
    executor,
    sql`SELECT i.iss_seq FROM issues i
          LEFT JOIN issue_alike_seeds s ON s.issue_id = i.id
         WHERE i.project_id = ${projectId}::uuid AND i.archived_at IS NULL
           AND i.status IN (${textList(UNSETTLED_STATUSES)})
           AND (s.issue_id IS NULL OR s.measured_with <> ${measuredWith} OR s.title <> i.title)
         ORDER BY i.iss_seq`,
  );
  const [counted] = await rowsOf(
    executor,
    sql`SELECT count(*)::int AS n FROM issues
         WHERE project_id = ${projectId}::uuid AND archived_at IS NULL
           AND status IN (${textList(UNSETTLED_STATUSES)})`,
  );
  const total = Number(counted?.n ?? 0);
  if (uncovered.length > 0) {
    const sample = uncovered.slice(0, 20).map((row) => refOf(Number(row.iss_seq)));
    throw new BacklogIndexRefused(
      'ALIKE_INDEX_INCOMPLETE',
      `the neighbours index has not measured ${uncovered.length} of ${total} unsettled issue(s), ` +
        `for example ${sample.slice(0, 5).join(', ')}. No sweep is served over a part of the backlog ` +
        `and called whole${catchUpRefusal ? `: ${catchUpRefusal}` : '; the index is being brought up to date, so ask again'}.`,
      { projectId, unsettled: total, unmeasured: uncovered.length, issues: sample },
    );
  }

  const pending = await pendingFor(executor, projectId, ['alike-seed', 'alike-target']);
  const seedRows = await rowsOf(
    executor,
    sql`SELECT i.id::text AS id, i.iss_seq, i.title, s.measured_at,
               EXISTS (SELECT 1 FROM backlog_index_dirty d
                        WHERE d.project_id = s.project_id AND d.index_kind = 'alike-seed'
                          AND d.subject_id = s.issue_id) AS seed_pending,
               EXISTS (SELECT 1 FROM issue_alike_hits h
                         JOIN backlog_index_dirty d ON d.project_id = s.project_id
                          AND d.index_kind = 'alike-target' AND d.subject_id = h.hit_issue_id
                        WHERE h.seed_issue_id = s.issue_id) AS lists_pending
          FROM issue_alike_seeds s JOIN issues i ON i.id = s.issue_id
         WHERE s.project_id = ${projectId}::uuid AND i.archived_at IS NULL
           AND i.status IN (${textList(UNSETTLED_STATUSES)}) AND i.iss_seq > ${query.after}
         ORDER BY i.iss_seq
         LIMIT ${query.limit + 1}`,
  );
  const page = seedRows.slice(0, query.limit);
  const hitRows = page.length
    ? await rowsOf(
        executor,
        sql`SELECT seed_issue_id::text AS seed, memory_id::text AS memory_id,
                   hit_issue_id::text AS hit_issue_id, score, stale, position
              FROM issue_alike_hits
             WHERE seed_issue_id = ANY(${uuidArray(page.map((row) => String(row.id)))})
               AND position < ${query.topK}
             ORDER BY seed_issue_id, position`,
      )
    : [];
  const hitsOf = new Map<string, NeighbourHit[]>();
  for (const row of hitRows) {
    const held = hitsOf.get(String(row.seed)) ?? [];
    held.push({
      memoryId: String(row.memory_id),
      sourceRef: row.hit_issue_id ? String(row.hit_issue_id) : '',
      score: Number(row.score),
      stale: row.stale === true,
    });
    hitsOf.set(String(row.seed), held);
  }

  const seeds: NeighbourSeed[] = page.map((row) => ({
    issueId: String(row.id),
    displayId: refOf(Number(row.iss_seq)),
    title: String(row.title),
    measuredAt: new Date(String(row.measured_at)).toISOString(),
    stale: row.seed_pending === true || row.lists_pending === true,
    hits: hitsOf.get(String(row.id)) ?? [],
  }));

  const last = page[page.length - 1];
  return {
    seeds,
    total,
    topK: query.topK,
    next: seedRows.length > query.limit && last ? Number(last.iss_seq) : null,
    index: {
      state: pending.pending > 0 ? 'stale' : 'fresh',
      pending: pending.pending,
      oldestPendingAt: pending.oldestMarkedAt ? pending.oldestMarkedAt.toISOString() : null,
    },
  };
}

export { ALIKE_TOP_K };
