import { and, eq, isNotNull, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { terminalAgentSessionStatuses } from '../db/session-vocabulary.js';
import { logger } from '../logger.js';
import { resolveNotificationById, resolveNotifications } from '../notifications/auto-resolve.js';
import { PENDING_STALE_MS } from '../notifications/deliver.js';
import { stuckRankSql } from '../projects/stuck-issue-kinds.js';
import { RELEASED_PER_PASS } from './owed-sighting.js';
import { WEDGE_KEY_KINDS, WEDGE_KEY_SHAPES, type WedgeKeyKind } from './wedge.js';

export interface ReevaluateResult {
  /** Firing conditions whose subject is over. */
  resolved: number;
  /** Inhibited children returned to pending because their root cleared. */
  released: number;
  /** Pending records whose producer stopped seeing them. */
  dropped: number;
}

/** A firing wedge's key, the part after `wedge:`, and the uuid its subject is named by. */
interface WedgeKeyParts {
  rest: SQL;
  uid: SQL;
}

const TERMINAL_SESSION = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

/**
 * ISS-1229 r16 — whether the subject a wedge of each kind names still holds. A wedge whose subject
 * holds under none of the kinds its key's shape can name has ended, and that includes a subject
 * whose row is gone. The record is total over `WEDGE_KEY_KINDS`, so a kind cannot be added without
 * the resolver that ends it; `emitPipelineWedge` refuses a key no kind's shape matches.
 */
const STILL_HOLDS: Readonly<Record<WedgeKeyKind, (w: WedgeKeyParts) => SQL>> = {
  job: ({ uid }) => sql`EXISTS (SELECT 1 FROM jobs j WHERE j.id = ${uid}
                                  AND j.status IN ('queued','dispatched','running','held'))`,
  session: ({ uid }) => sql`EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = ${uid}
                                      AND s.status NOT IN (${TERMINAL_SESSION}))`,
  runner: ({ uid }) => sql`EXISTS (SELECT 1 FROM runners r WHERE r.id = ${uid}
                                     AND (r.limit_reason = 'auth' OR r.quarantined_until > now()))`,
  // Raised once the row is out of redeliveries, so its row is never processed: what ends it is the
  // issue moving on — off the status the change took it to, finished, archived, or the change re-applied.
  outbox: ({ uid }) => sql`EXISTS (SELECT 1 FROM pipeline_outbox o JOIN issues i ON i.id = o.issue_id
                                    WHERE o.id = ${uid} AND o.processed_at IS NULL
                                      AND i.status = o.to_status
                                      AND i.status NOT IN ('closed', 'dropped')
                                      AND i.archived_at IS NULL
                                      AND NOT EXISTS (SELECT 1 FROM pipeline_outbox later
                                                       WHERE later.issue_id = o.issue_id
                                                         AND later.created_at > o.created_at
                                                         AND later.processed_at IS NOT NULL))`,
  // Capacity is short only while work waits for it: no queued job of the stage, nothing is held up.
  capacity: ({ rest, uid }) => sql`EXISTS (SELECT 1 FROM jobs j WHERE j.project_id = ${uid}
                                             AND j.status = 'queued'
                                             AND (split_part(${rest}, ':', 3) = 'all'
                                                  OR j.type = split_part(${rest}, ':', 3)))`,
  paused_run: ({ uid }) => sql`EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = ${uid}
                                         AND r.status = 'paused')`,
  review_rounds: ({ uid }) => sql`EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = ${uid}
                                            AND r.status IN ('running','paused'))`,
};

/** The kinds sharing one key shape: a bare uuid names a job, a session, a runner or an outbox row. */
function holdsUnderShape(shape: string, w: WedgeKeyParts): SQL {
  const kinds = WEDGE_KEY_KINDS.filter((k) => WEDGE_KEY_SHAPES[k].source === shape);
  return sql`(${sql.join(
    kinds.map((k) => STILL_HOLDS[k](w)),
    sql` OR `,
  )})`;
}

/** Every firing wedge whose subject is over, and every one keyed on a shape no resolver reads. */
async function endedWedges(): Promise<{ ended: string[]; unread: string[] }> {
  const shapes = [...new Set(WEDGE_KEY_KINDS.map((k) => WEDGE_KEY_SHAPES[k].source))];
  const w: WedgeKeyParts = {
    rest: sql`k.rest`,
    uid: sql`substring(k.rest from ${'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'})::uuid`,
  };
  const rows = await db.execute<{ resolution_key: string; shape: number | null }>(sql`
    WITH k AS (
      SELECT n.resolution_key, substring(n.resolution_key from 7) AS rest
        FROM notifications n
       WHERE n.type = 'pipeline_wedge' AND n.state = 'firing' AND n.resolved_at IS NULL
         AND n.resolution_key LIKE 'wedge:%'
    )
    SELECT k.resolution_key,
           CASE ${sql.join(
             shapes.map((shape, i) => sql`WHEN k.rest ~ ${shape} THEN ${i}`),
             sql` `,
           )} END AS shape
      FROM k
     WHERE CASE ${sql.join(
       shapes.map((shape) => sql`WHEN k.rest ~ ${shape} THEN NOT ${holdsUnderShape(shape, w)}`),
       sql` `,
     )} ELSE true END
  `);
  return {
    ended: rows.filter((r) => r.shape !== null).map((r) => r.resolution_key),
    unread: rows.filter((r) => r.shape === null).map((r) => r.resolution_key),
  };
}

/** Firing wedges stored with no key at all, from before keys existed: no resolver could reach one. */
async function keylessWedges(): Promise<Array<{ id: string; title: string; project_id: string | null }>> {
  return db.execute<{ id: string; title: string; project_id: string | null }>(sql`
    SELECT n.id, n.title, n.project_id FROM notifications n
     WHERE n.type = 'pipeline_wedge' AND n.state = 'firing' AND n.resolved_at IS NULL
       AND n.resolution_key IS NULL
  `);
}

/** Held stuck-issue notices a more specific notice still standing for the same issue outranks. */
async function outrankedHeldKeys(): Promise<string[]> {
  const rows = await db.execute<{ resolution_key: string }>(sql`
    SELECT DISTINCT held.resolution_key FROM notifications held
     WHERE held.state = 'inhibited' AND held.type = 'issue_stranded'
       AND held.resolved_at IS NULL AND held.issue_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM notifications up
          WHERE up.issue_id = held.issue_id AND up.type = 'issue_stranded'
            AND up.resolved_at IS NULL AND up.id <> held.id
            AND ${stuckRankSql(sql`up.resolution_key`)} < ${stuckRankSql(sql`held.resolution_key`)}
       )
  `);
  return rows.map((r) => r.resolution_key);
}

/** Never throws — same contract as every other sweeper pass. */
export async function reevaluateConditions(now: Date = new Date()): Promise<ReevaluateResult> {
  const result: ReevaluateResult = { resolved: 0, released: 0, dropped: 0 };
  try {
    const wedges = await endedWedges();
    if (wedges.unread.length > 0) {
      logger.error(
        { keys: wedges.unread },
        "notifications: ended wedges keyed on a shape no resolver reads — nothing could ever end them, and each held its project's stuck-issue notices",
      );
    }
    for (const key of [...wedges.ended, ...wedges.unread]) {
      result.resolved += await resolveNotifications(key);
    }
    const keyless = await keylessWedges();
    if (keyless.length > 0) {
      logger.error(
        { wedges: keyless.map((w) => ({ id: w.id, title: w.title, projectId: w.project_id })) },
        "notifications: ended wedges stored with no key — nothing could ever end them, and each held its project's stuck-issue notices",
      );
    }
    for (const w of keyless) result.resolved += await resolveNotificationById(w.id);

    // One issue, one stuck reason (criterion 94): released together, each would go out.
    for (const key of await outrankedHeldKeys()) {
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
