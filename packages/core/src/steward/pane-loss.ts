// The steward's bound on placing one item's runner job again after its box lost the last one's pane
// (ISS-1415). A failed steward job is never retried by the pool (`POOL_UNRETRIED_JOB_TYPES`): the
// item's standing queues its next run, and a release follow-through on a shipped issue reads no open
// standing, so no basis held it as a repeat (`policy.ts:admitRun`), and gwork's ISS-109 follow-through
// went out about 31 times in 95 minutes. Every steward job starts at `dispatch.ts:runOne`, so the
// bound is read there, from the item's own ended jobs, by the rules the pool's retries read
// (`jobs/pane-loss.ts`): its next job waits out a growing interval, and past the cap it is placed
// held, for a person's resume (`POST /api/jobs/:id/resume`), which is their ask for it again.

import type { StewardJobPlacement } from '@forge/contracts/steward-runtime';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import {
  PANE_LOSS_CAP,
  type PaneLossPlacement,
  type PaneLossStreak,
  paneLossPlacement,
  paneLossStreak,
} from '../jobs/index.js';

/** The item's newest steward jobs in a row that ended on their box losing the job's pane. */
export async function stewardPaneLosses(subject: {
  kind: string;
  id: string;
}): Promise<PaneLossStreak> {
  const rows = rowsOf<{
    status: string;
    error: string | null;
    ended_at: string | null;
    asked: boolean;
  }>(
    await db.execute(sql`
      SELECT j.status, coalesce(j.error, j.failure_reason) AS error,
             coalesce(j.finished_at, r.ended_at)::text AS ended_at,
             (j.payload -> '__hold') IS NOT NULL AS asked
        FROM steward_runs r
        JOIN jobs j ON j.id = r.job_id
       WHERE r.subject_kind = ${subject.kind} AND r.subject_id = ${subject.id}
         AND r.state IN ('done', 'failed')
       ORDER BY r.ended_at DESC NULLS LAST, r.queued_at DESC
       LIMIT ${PANE_LOSS_CAP + 1}`),
  );
  return paneLossStreak(
    rows.map((r) => ({
      status: r.status,
      error: r.error,
      endedAt: r.ended_at ? new Date(r.ended_at) : null,
      askedByPerson: r.asked,
    })),
  );
}

/** Whether the item's next steward job may be placed now, and the streak that says so. */
export async function stewardJobPlacementOf(
  subject: { kind: string; id: string },
  now = new Date(),
): Promise<{ streak: PaneLossStreak; placement: PaneLossPlacement }> {
  const streak = await stewardPaneLosses(subject);
  return { streak, placement: paneLossPlacement(streak.losses, streak.lastAt, now) };
}

/** The placement as the item's standing read answers it (`steward-runs`). */
export function placementView(
  streak: PaneLossStreak,
  placement: PaneLossPlacement,
): StewardJobPlacement {
  return {
    paneLosses: streak.losses,
    lastFailure: streak.lastFailure,
    nextAt: placement.kind === 'wait' ? placement.at.toISOString() : null,
    stopped: placement.kind === 'stop',
  };
}
