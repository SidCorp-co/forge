import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { INITIAL_STATE, kindOf, tierOf } from './kinds.js';

const KIND = kindOf('ops_alert');
const TIER = tierOf('ops_alert');

/**
 * Raise an ops alert, or re-word the one already firing under its key: `escalated` when its
 * severity moved. Null when the alert under the key was resolved while it was being re-worded.
 */
export async function claimOpsAlert(input: {
  title: string;
  body: string;
  severity: 'warning' | 'error';
  resolutionKey: string;
}): Promise<{ id: string; escalated: boolean } | null> {
  const { title, body, severity, resolutionKey } = input;

  const claimed = await db.execute<{ id: string }>(sql`
    INSERT INTO notifications (project_id, type, kind, tier, state, title, body, severity, resolution_key, pending_since, last_seen_at, created_at, level_changed_at)
    VALUES (NULL, 'ops_alert', ${KIND}, ${TIER}, ${INITIAL_STATE[KIND]}, ${title}, ${body}, ${severity}, ${resolutionKey}, now(), now(), now(), now())
    ON CONFLICT (resolution_key) WHERE resolved_at IS NULL AND resolution_key IS NOT NULL AND type = 'ops_alert' DO NOTHING
    RETURNING id
  `);
  if (claimed[0]?.id) return { id: claimed[0].id, escalated: false };

  {
    const updated = await db.execute<{ id: string; escalated: boolean }>(sql`
      WITH locked AS (
        SELECT id, severity FROM notifications
        WHERE resolution_key = ${resolutionKey}
          AND type = 'ops_alert' AND resolved_at IS NULL
        FOR UPDATE
      )
      UPDATE notifications n
      SET severity = ${severity}, title = ${title}, body = ${body}, last_seen_at = now(),
          level_changed_at = CASE WHEN prev.severity IS DISTINCT FROM ${severity} THEN now() ELSE n.level_changed_at END
      FROM locked prev
      WHERE prev.id = n.id
      RETURNING n.id, (prev.severity IS DISTINCT FROM ${severity}) AS escalated
    `);
    if (!updated[0]) return null;
    return { id: updated[0].id, escalated: updated[0].escalated };
  }
}

/** Un-read every admin's delivery of this record — an escalation has to reach a surface. */
export async function unreadAlertDeliveries(notificationId: string): Promise<void> {
  await db.execute(sql`
    UPDATE notification_deliveries d SET read_at = NULL
    FROM notification_delivery_members m
    WHERE m.delivery_id = d.id AND m.notification_id = ${notificationId}
  `);
}

/** Where an ops alert's level stands on record: its open row's severity and when it was set, else when it last went back to ok. */
export interface OpsAlertChange {
  open: { severity: string; changedAt: Date } | null;
  resolvedAt: Date | null;
}

/** Each resolution key's recorded level change (REQ-22 BC-1); a key never alerted is absent. */
export async function opsAlertChanges(
  keys: readonly string[],
): Promise<Map<string, OpsAlertChange>> {
  if (keys.length === 0) return new Map();
  const rows = await db.execute<{
    key: string;
    severity: string | null;
    changed_at: string | Date | null;
    resolved_at: string | Date | null;
  }>(sql`
    SELECT resolution_key AS key,
           max(severity) FILTER (WHERE resolved_at IS NULL) AS severity,
           max(coalesce(level_changed_at, created_at)) FILTER (WHERE resolved_at IS NULL) AS changed_at,
           max(resolved_at) AS resolved_at
    FROM notifications
    WHERE type = 'ops_alert' AND resolution_key IN (${sql.join(
      keys.map((k) => sql`${k}`),
      sql`, `,
    )})
    GROUP BY resolution_key
  `);
  const at = (v: string | Date | null) => (v === null ? null : new Date(v));
  return new Map(
    rows.map((r) => [
      r.key,
      {
        open:
          r.severity !== null && r.changed_at !== null
            ? { severity: r.severity, changedAt: at(r.changed_at) as Date }
            : null,
        resolvedAt: at(r.resolved_at),
      },
    ]),
  );
}
