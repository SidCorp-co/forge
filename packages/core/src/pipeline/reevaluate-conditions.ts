import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { logger } from '../logger.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';
import { PENDING_STALE_MS } from '../notifications/deliver.js';
import { RELEASED_PER_PASS } from './owed-sighting.js';

export interface ReevaluateResult {
  /** Firing conditions whose subject is over. */
  resolved: number;
  /** Inhibited children returned to pending because their root cleared. */
  released: number;
  /** Pending records whose producer stopped seeing them. */
  dropped: number;
}

async function endedWedges(): Promise<string[]> {
  const rows = await db.execute<{ resolution_key: string }>(sql`
    SELECT n.resolution_key FROM notifications n
     WHERE n.type = 'pipeline_wedge' AND n.state = 'firing' AND n.resolved_at IS NULL
       AND n.resolution_key ~ '^wedge:[0-9a-f]{8}-'
       AND (
         EXISTS (SELECT 1 FROM jobs j
                  WHERE j.id = substring(n.resolution_key from 7)::uuid
                    AND j.status IN ('done','failed','cancelled'))
         OR EXISTS (SELECT 1 FROM pipeline_runs r
                     WHERE r.id = substring(n.resolution_key from 7)::uuid
                       AND r.status IN ('completed','failed','cancelled'))
       )
  `);
  return rows.map((r) => r.resolution_key);
}

/** Never throws — same contract as every other sweeper pass. */
export async function reevaluateConditions(now: Date = new Date()): Promise<ReevaluateResult> {
  const result: ReevaluateResult = { resolved: 0, released: 0, dropped: 0 };
  try {
    for (const key of await endedWedges()) {
      result.resolved += await resolveNotifications(key);
    }

    // Released a bounded batch a pass, longest-held first, so the sweeps can see every released
    // condition again before it would go stale (owed-sighting.ts); the rest stay inhibited.
    const released = await db.execute<{ id: string }>(sql`
      UPDATE notifications n
         SET state = 'pending', inhibited_by = NULL, pending_since = ${now.toISOString()}::timestamptz,
             last_seen_at = ${now.toISOString()}::timestamptz
       WHERE n.id IN (
         SELECT held.id FROM notifications held
           JOIN notifications root ON root.id = held.inhibited_by
          WHERE held.state = 'inhibited'
            AND root.resolved_at IS NOT NULL
          ORDER BY held.pending_since ASC, held.id ASC
          LIMIT ${RELEASED_PER_PASS}
       )
      RETURNING n.id
    `);
    result.released = released.length;

    const dropped = await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.state, 'pending'),
          isNull(notifications.resolvedAt),
          isNotNull(notifications.lastSeenAt),
          lt(notifications.lastSeenAt, new Date(now.getTime() - PENDING_STALE_MS)),
        ),
      )
      .returning({ id: notifications.id });
    result.dropped = dropped.length;

    if (result.resolved > 0 || result.released > 0 || result.dropped > 0) {
      logger.info(result, 'notifications: re-evaluated conditions');
    }
    return result;
  } catch (err) {
    logger.error({ err }, 'notifications: re-evaluation failed');
    return result;
  }
}
