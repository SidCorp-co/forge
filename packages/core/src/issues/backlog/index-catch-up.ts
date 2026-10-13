/**
 * What a read does before it answers, and what the one-minute tick does for a project nobody is
 * reading (ISS-1336): marks what no write announced, then drains the queue within a budget.
 *
 * The work is the pending set, not the backlog: a read after one change drains one change. A read
 * that cannot finish inside its budget answers anyway and says what is still pending.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { BacklogIndexKind } from '../../db/schema-backlog-index.js';
import { drainAlike } from './alike-maintainer.js';
import { pendingFor } from './index-dirty.js';
import {
  type IndexExecutor,
  rowsOf,
  TAKEABLE_STATUSES,
  textList,
  UNSETTLED_STATUSES,
} from './index-sql.js';
import { drainRank } from './rank-maintainer.js';

export interface CatchUpResult {
  /** True when nothing was pending when the pass ended. */
  drained: boolean;
  passes: number;
  /** The sentence naming why the pass stopped short of a drain it could not make, where there is one. */
  refusal?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_MS = 50;

/**
 * Scores whose chain walked an edge that has since lapsed are marked, since a lapse is a change no
 * write made. Without this a clock-driven change would sit unnamed until the next write.
 */
export async function markLapsedRank(executor: IndexExecutor, projectId: string): Promise<number> {
  const rows = await rowsOf(
    executor,
    sql`SELECT backlog_index_mark('rank', ${projectId}::uuid, s.issue_id, 'an edge on its chain lapsed')
          FROM issue_rank_scores s
         WHERE s.project_id = ${projectId}::uuid AND s.fresh_until IS NOT NULL AND s.fresh_until <= now()`,
  );
  return rows.length;
}

/**
 * Takeable issues with no score stored under the weights in force are marked, whatever the reason
 * (a row lost, weights moved without a trigger seeing it, a built-in table that changed).
 */
export async function markUncoveredRank(
  executor: IndexExecutor,
  projectId: string,
  hash: string,
): Promise<number> {
  const rows = await rowsOf(
    executor,
    sql`SELECT backlog_index_mark('rank', ${projectId}::uuid, i.id, 'no score stored under the weights in force')
          FROM issues i
         WHERE i.project_id = ${projectId}::uuid AND i.archived_at IS NULL
           AND i.status IN (${textList(TAKEABLE_STATUSES)})
           AND NOT EXISTS (SELECT 1 FROM issue_rank_scores s WHERE s.issue_id = i.id AND s.weights_hash = ${hash})`,
  );
  return rows.length;
}

/**
 * Unsettled issues with no neighbour set stored, or one measured under another memory model or
 * embeddings model than the project reads now, or for a title the issue no longer carries.
 */
export async function markUncoveredAlike(
  executor: IndexExecutor,
  projectId: string,
  measuredWith: string,
): Promise<number> {
  const rows = await rowsOf(
    executor,
    sql`SELECT backlog_index_mark('alike-seed', ${projectId}::uuid, i.id, 'no neighbour set measured now')
          FROM issues i
          LEFT JOIN issue_alike_seeds s ON s.issue_id = i.id
         WHERE i.project_id = ${projectId}::uuid AND i.archived_at IS NULL
           AND i.status IN (${textList(UNSETTLED_STATUSES)})
           AND (s.issue_id IS NULL OR s.measured_with <> ${measuredWith} OR s.title <> i.title)`,
  );
  return rows.length;
}

interface Drainer {
  kinds: readonly BacklogIndexKind[];
  /** Marks what no write announced; called once before the first pass. */
  mark: (projectId: string) => Promise<void>;
  drain: (
    projectId: string,
    options: { deadline: number },
  ) => Promise<{ outcome: string; refusal?: string }>;
}

async function run(drainer: Drainer, projectId: string, budgetMs: number): Promise<CatchUpResult> {
  if (budgetMs <= 0) return { drained: false, passes: 0 };
  const deadline = Date.now() + budgetMs;
  await drainer.mark(projectId);
  let passes = 0;
  for (;;) {
    const { pending } = await pendingFor(db, projectId, drainer.kinds);
    if (pending === 0) return { drained: true, passes };
    if (Date.now() >= deadline) return { drained: false, passes };
    const result = await drainer.drain(projectId, { deadline });
    if (result.outcome === 'refused') {
      return { drained: false, passes, ...(result.refusal ? { refusal: result.refusal } : {}) };
    }
    if (result.outcome === 'drained') passes += 1;
    else await sleep(RETRY_MS);
  }
}

export async function catchUpRank(
  projectId: string,
  budgetMs: number,
  hash: string,
): Promise<CatchUpResult> {
  return run(
    {
      kinds: ['rank'],
      mark: async (id) => {
        await markLapsedRank(db, id);
        await markUncoveredRank(db, id, hash);
      },
      drain: (id) => drainRank(id),
    },
    projectId,
    budgetMs,
  );
}

export async function catchUpAlike(
  projectId: string,
  budgetMs: number,
  measuredWith: string,
): Promise<CatchUpResult> {
  return run(
    {
      kinds: ['alike-seed', 'alike-target'],
      mark: async (id) => {
        await markUncoveredAlike(db, id, measuredWith);
      },
      drain: drainAlike,
    },
    projectId,
    budgetMs,
  );
}
