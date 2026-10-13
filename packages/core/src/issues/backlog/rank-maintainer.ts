/**
 * Keeps `issue_rank_scores` current (ISS-1336): takes the changes the triggers queued, scores the
 * issues they can move, and stores the rows in the same transaction that deletes what it read.
 *
 * The set a change can move is the issue and everything that holds it up, because a chain counts
 * what is below it. An issue that left the takeable set loses its row; one that entered gains it.
 * A mark that names the whole project (a weight, a module label, the backfill) rescored them all.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { claimMarks, isWholeProject, releaseMarks, tryDrainLock } from './index-dirty.js';
import { type IndexExecutor, rowsOf, TAKEABLE_STATUSES, textList, uuidArray } from './index-sql.js';
import { chainsOf, withBlockers } from './rank-chain.js';
import { loadRankContext, type RankContext } from './rank-context.js';
import { moduleTermOf, type RankIssueFacts, type RankPart, staticScoreOf } from './rank-score.js';

/** Marks one drain takes; a project with more drains over several passes. */
export const RANK_DRAIN_BATCH = 500;

/** Rows written per statement, so a whole-project rescore stays under the driver's parameter limit. */
const UPSERT_CHUNK = 500;

export interface RankDrainResult {
  outcome: 'drained' | 'idle' | 'busy' | 'refused';
  /** The marks this pass read. */
  claimed: number;
  /** Every issue whose score was computed and stored. */
  rescored: string[];
  /** Every issue whose row was deleted because it is no longer takeable. */
  removed: string[];
  /** The sentence naming why no score was stored, where the outcome is `refused`. */
  refusal?: string;
}

interface IssueFacts extends RankIssueFacts {
  id: string;
  takeable: boolean;
  moduleId: string | null;
}

async function loadFacts(
  executor: IndexExecutor,
  projectId: string,
  ids: readonly string[] | null,
): Promise<IssueFacts[]> {
  const scope =
    ids === null
      ? sql`AND i.status IN (${textList(TAKEABLE_STATUSES)}) AND i.archived_at IS NULL`
      : sql`AND i.id = ANY(${uuidArray(ids)})`;
  const rows = await rowsOf(
    executor,
    sql`
    SELECT i.id::text AS id, i.status, i.priority, i.category, i.complexity, i.reopen_count,
           i.archived_at IS NOT NULL AS archived,
           (SELECT l.id::text
              FROM issue_labels il JOIN labels l ON l.id = il.label_id
             WHERE il.issue_id = i.id AND il.is_primary AND l.kind = 'module'
             LIMIT 1) AS module_id
      FROM issues i
     WHERE i.project_id = ${projectId}::uuid ${scope}`,
  );
  return rows.map((row) => ({
    id: String(row.id),
    priority: row.priority === null ? null : String(row.priority),
    category: row.category === null ? null : String(row.category),
    complexity: row.complexity === null ? null : String(row.complexity),
    reopenCount: Number(row.reopen_count),
    takeable: (TAKEABLE_STATUSES as string[]).includes(String(row.status)) && row.archived !== true,
    moduleId: row.module_id ? String(row.module_id) : null,
  }));
}

interface ScoredRow {
  issueId: string;
  total: number;
  parts: RankPart[];
  chainCount: number;
  lapsesAt: Date | null;
}

async function scoreAll(
  executor: IndexExecutor,
  projectId: string,
  facts: IssueFacts[],
  context: RankContext,
): Promise<ScoredRow[]> {
  const chains = await chainsOf(
    executor,
    projectId,
    facts.map((one) => one.id),
  );
  const byId = new Map(context.modules.map((one) => [one.id, one]));
  return facts.map((one) => {
    const chain = chains.get(one.id) ?? { count: 0, lapsesAt: null };
    const term = moduleTermOf(
      one.moduleId ? (byId.get(one.moduleId) ?? null) : null,
      context.modules,
      context.moduleTable,
    );
    const score = staticScoreOf(one, chain.count, term, context.weights);
    return {
      issueId: one.id,
      total: score.total,
      parts: score.parts,
      chainCount: chain.count,
      lapsesAt: chain.lapsesAt,
    };
  });
}

async function storeScores(
  executor: IndexExecutor,
  projectId: string,
  scored: ScoredRow[],
  hash: string,
): Promise<void> {
  for (let at = 0; at < scored.length; at += UPSERT_CHUNK) {
    const chunk = scored.slice(at, at + UPSERT_CHUNK);
    await executor.execute(sql`
      INSERT INTO issue_rank_scores
        (issue_id, project_id, static_score, parts, chain_count, weights_hash, fresh_until, computed_at)
      SELECT v.issue_id, ${projectId}::uuid, v.static_score, v.parts, v.chain_count, ${hash}, v.fresh_until, now()
        FROM (VALUES ${sql.join(
          chunk.map(
            (one) =>
              sql`(${one.issueId}::uuid, ${one.total}::double precision, ${JSON.stringify(one.parts)}::jsonb,
                   ${one.chainCount}::int, ${one.lapsesAt ? one.lapsesAt.toISOString() : null}::timestamptz)`,
          ),
          sql`, `,
        )}) AS v(issue_id, static_score, parts, chain_count, fresh_until)
      ON CONFLICT (issue_id) DO UPDATE SET
        static_score = EXCLUDED.static_score, parts = EXCLUDED.parts,
        chain_count = EXCLUDED.chain_count, weights_hash = EXCLUDED.weights_hash,
        fresh_until = EXCLUDED.fresh_until, computed_at = EXCLUDED.computed_at`);
  }
}

async function removeRows(
  executor: IndexExecutor,
  projectId: string,
  ids: readonly string[] | null,
): Promise<string[]> {
  const scope =
    ids === null
      ? sql`AND NOT EXISTS (
          SELECT 1 FROM issues i
           WHERE i.id = s.issue_id AND i.archived_at IS NULL
             AND i.status IN (${textList(TAKEABLE_STATUSES)}))`
      : sql`AND s.issue_id = ANY(${uuidArray(ids)})`;
  const rows = await rowsOf(
    executor,
    sql`DELETE FROM issue_rank_scores s WHERE s.project_id = ${projectId}::uuid ${scope}
        RETURNING s.issue_id::text AS id`,
  );
  return rows.map((row) => String(row.id));
}

/**
 * One pass. The advisory lock makes it the only drain of this project, so the generation a mark
 * carried is the only concurrency a write can add, and the delete of what was read honours it.
 */
export async function drainRank(
  projectId: string,
  options: { batch?: number } = {},
): Promise<RankDrainResult> {
  return db.transaction(async (tx): Promise<RankDrainResult> => {
    const none = { claimed: 0, rescored: [], removed: [] };
    if (!(await tryDrainLock(tx, 'rank', projectId))) return { outcome: 'busy', ...none };
    const marks = await claimMarks(tx, projectId, ['rank'], options.batch ?? RANK_DRAIN_BATCH);
    if (marks.length === 0) return { outcome: 'idle', ...none };

    const context = await loadRankContext(tx, projectId);
    if (context.refusal) {
      return { outcome: 'refused', ...none, claimed: marks.length, refusal: context.refusal };
    }

    const whole = marks.some(isWholeProject);
    let rescored: string[];
    let removed: string[];
    if (whole) {
      const facts = await loadFacts(tx, projectId, null);
      removed = await removeRows(tx, projectId, null);
      await storeScores(tx, projectId, await scoreAll(tx, projectId, facts, context), context.hash);
      rescored = facts.map((one) => one.id);
    } else {
      const named = marks.map((one) => one.subjectId);
      const affected = await withBlockers(tx, projectId, named);
      const present = await loadFacts(tx, projectId, affected);
      const takeable = present.filter((one) => one.takeable);
      const takeableIds = new Set(takeable.map((one) => one.id));
      removed = await removeRows(
        tx,
        projectId,
        affected.filter((id) => !takeableIds.has(id)),
      );
      await storeScores(
        tx,
        projectId,
        await scoreAll(tx, projectId, takeable, context),
        context.hash,
      );
      rescored = takeable.map((one) => one.id);
    }

    await releaseMarks(tx, projectId, marks);
    return { outcome: 'drained', claimed: marks.length, rescored, removed };
  });
}
