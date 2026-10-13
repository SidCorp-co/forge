/**
 * The safety net under the maintained indexes (ISS-1336): once a minute, every project with a
 * pending change or a lapsed edge is brought up to date, so the indexes converge with nobody
 * reading them. A read catches up on its own; this is for the project that is not being read.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { logger } from '../../logger.js';
import { boss } from '../../queue/boss.js';
import { currentMeasuredWith } from './alike-maintainer.js';
import { catchUpAlike, catchUpRank } from './index-catch-up.js';
import { rowsOf } from './index-sql.js';
import { loadRankContext } from './rank-context.js';

export const BACKLOG_INDEX_QUEUE = 'backlog-index.maintain';
const BACKLOG_INDEX_CRON = '* * * * *';

/** Projects one tick takes; a fleet with more drains over ticks, oldest change first. */
export const BACKLOG_INDEX_PROJECTS_PER_TICK = 25;
/** What one project may spend per tick on each index. */
export const BACKLOG_INDEX_BUDGET_MS = 20_000;

let registered = false;

/** Brings every project with pending work up to date, up to this tick's budget; returns the ones it visited. */
export async function runBacklogIndexTickOnce(): Promise<string[]> {
  const rows = await rowsOf(
    db,
    sql`SELECT project_id::text AS project_id FROM (
          SELECT project_id, min(first_marked_at) AS at FROM backlog_index_dirty GROUP BY project_id
          UNION ALL
          SELECT project_id, min(fresh_until) AS at FROM issue_rank_scores
           WHERE fresh_until IS NOT NULL AND fresh_until <= now() GROUP BY project_id
        ) pending GROUP BY project_id ORDER BY min(at) LIMIT ${BACKLOG_INDEX_PROJECTS_PER_TICK}`,
  );
  const visited: string[] = [];
  for (const row of rows) {
    const projectId = String(row.project_id);
    try {
      const context = await loadRankContext(db, projectId);
      if (context.refusal) {
        logger.warn(
          { projectId, refusal: context.refusal },
          'backlog-index: ranking weights refused',
        );
      } else {
        await catchUpRank(projectId, BACKLOG_INDEX_BUDGET_MS, context.hash);
      }
      const caught = await catchUpAlike(
        projectId,
        BACKLOG_INDEX_BUDGET_MS,
        await currentMeasuredWith(projectId),
      );
      if (caught.refusal)
        logger.warn(
          { projectId, refusal: caught.refusal },
          'backlog-index: neighbours not caught up',
        );
      visited.push(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'backlog-index: project failed');
    }
  }
  if (visited.length > 0) logger.info({ projects: visited.length }, 'backlog-index: caught up');
  return visited;
}

export async function registerBacklogIndexSweeper(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(BACKLOG_INDEX_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(BACKLOG_INDEX_QUEUE, async () => {
    try {
      await runBacklogIndexTickOnce();
    } catch (err) {
      logger.error({ err }, 'backlog-index: tick failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(BACKLOG_INDEX_QUEUE, BACKLOG_INDEX_CRON, {});
  registered = true;
}

export async function unregisterBacklogIndexSweeper(): Promise<void> {
  if (!registered) return;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
    await (boss as any).unschedule?.(BACKLOG_INDEX_QUEUE);
  } catch {
    // best-effort: a schedule that never existed has nothing to remove
  }
  registered = false;
}
