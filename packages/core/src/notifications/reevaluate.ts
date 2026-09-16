/**
 * ISS-1063 — the loop that asks "is this still true?".
 *
 * A condition with nobody re-deriving it only ever accumulates. `pipeline_wedge` is what
 * that looks like: 2161 rows on the production replica and 124 of them resolved, 6%, over
 * three months. Its eight clearers are all event-driven — `jobs/hold.ts` on a release,
 * `jobs/retry.ts` on capacity returning, the runner fault paths, `inv7-alarms.ts` on a
 * resumed pause — so a wedge whose subject ended by a route nobody wired stays lit for
 * ever. This pass is the route nobody wired.
 *
 * Three things happen here and they are deliberately the only three:
 *
 * 1. A firing `pipeline_wedge` whose subject reached a terminal state is resolved. The
 *    subject is re-derived from the database, never from a clock — `wedge.ts` says in
 *    terms that a bell emptied on a schedule is emptied on a schedule rather than on a
 *    fact, and that rule still holds.
 * 2. An inhibited condition whose root has resolved goes back to `pending`. It is NOT
 *    delivered: the root clearing says nothing about the child, so the child's own
 *    producer has to see it again before anybody hears about it. Otherwise inhibition
 *    would trade one burst of alarms for one burst of all-clears.
 * 3. A `pending` record whose producer stopped emitting is dropped undelivered. Its
 *    condition cleared inside its own `for` window, which is what the `for` is for.
 */

import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { logger } from '../logger.js';
import { resolveNotifications } from './auto-resolve.js';
import { PENDING_STALE_MS } from './deliver.js';

export interface ReevaluateResult {
  /** Firing conditions whose subject is over. */
  resolved: number;
  /** Inhibited children returned to pending because their root cleared. */
  released: number;
  /** Pending records whose producer stopped seeing them. */
  dropped: number;
}

/**
 * Wedges whose subject the database says is finished.
 *
 * `wedgeResolutionKey` is `wedge:<entityId>`, and the entity is a job, session, run,
 * outbox row, issue, runner or a synthetic capacity/rounds/paused key. The uuid-shaped
 * ones are decidable here: a job or a pipeline run that reached a terminal status is not
 * wedged, whatever ended it. The synthetic keys (`capacity:`, `rounds:`, `paused:`) and
 * the runner ids are NOT decidable from this table and are deliberately left firing —
 * their own clearers own them, and guessing here would empty the bell on a guess.
 */
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

    // cm:guard back to `pending`, NEVER straight to `firing`. The root resolving is
    // evidence about the root and about nothing else; a child that cleared while it was
    // suppressed would otherwise be delivered as news the moment the root cleared, which
    // is one burst of alarms traded for one burst of all-clears.
    const released = await db.execute<{ id: string }>(sql`
      UPDATE notifications n
         SET state = 'pending', inhibited_by = NULL, pending_since = ${now}
        FROM notifications root
       WHERE n.inhibited_by = root.id
         AND n.state = 'inhibited'
         AND root.resolved_at IS NOT NULL
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
