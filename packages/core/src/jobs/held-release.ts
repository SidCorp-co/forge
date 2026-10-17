// A hold whose reason clears by itself — a box back, a budget renewed, a re-check due — is sent
// again by `releaseHeldJobs` once that is so (`jobs/hold.ts`). This pass is the one thing that
// calls it: once a minute, for every project holding a job (ISS-1421 r4).

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { releaseHeldJobs } from './hold.js';

export interface HeldReleaseResult {
  /** Held jobs queued again this pass. */
  released: number;
  /** Projects whose release threw; each is logged and the rest still run. */
  failed: number;
}

/** Every project holding a job whose re-check is due; `releaseHeldJobs` decides which go. */
async function projectsHolding(now: Date): Promise<string[]> {
  const rows = (await db.execute<{ project_id: string }>(sql`
    SELECT DISTINCT project_id FROM jobs
    WHERE status = 'held' AND (retry_after_at IS NULL OR retry_after_at <= ${now.toISOString()})
  `)) as unknown as Array<{ project_id: string }>;
  return rows.map((r) => r.project_id);
}

export async function releaseHeldJobsEverywhere(
  now: Date = new Date(),
): Promise<HeldReleaseResult> {
  const result: HeldReleaseResult = { released: 0, failed: 0 };
  for (const projectId of await projectsHolding(now)) {
    try {
      result.released += await releaseHeldJobs(projectId);
    } catch (err) {
      result.failed++;
      logger.error(
        { err, projectId },
        'held-release: could not release the held jobs of a project',
      );
    }
  }
  if (result.released > 0 || result.failed > 0) logger.info(result, 'held-release: pass done');
  return result;
}

const HELD_RELEASE_QUEUE = 'held-job-release';
let registered = false;

/** Run the pass once a minute on its own queue. */
export async function registerHeldJobRelease(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  await boss.createQueue(HELD_RELEASE_QUEUE);
  await boss.work(HELD_RELEASE_QUEUE, async () => {
    await releaseHeldJobsEverywhere();
  });
  await boss.schedule(HELD_RELEASE_QUEUE, '* * * * *');
  registered = true;
}

export function resetHeldJobReleaseForTest(): void {
  registered = false;
}
