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
    INSERT INTO notifications (project_id, type, kind, tier, state, title, body, severity, resolution_key, pending_since, last_seen_at, created_at)
    VALUES (NULL, 'ops_alert', ${KIND}, ${TIER}, ${INITIAL_STATE[KIND]}, ${title}, ${body}, ${severity}, ${resolutionKey}, now(), now(), now())
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
      SET severity = ${severity}, title = ${title}, body = ${body}, last_seen_at = now()
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
