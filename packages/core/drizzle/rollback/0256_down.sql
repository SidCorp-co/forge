-- ISS-1063 rollback — re-expand the record/delivery split into one row per recipient.
--
-- ORDER MATTERS: stop writes, run this, THEN start the old image. The old core reads
-- `notifications.user_id` and `notifications.read`, which 0256 dropped, so starting it
-- first gives a core that 500s on every bell request.
--
-- WHAT THIS CANNOT UNDO, stated rather than discovered:
--   * a `pending` or `inhibited` record has no delivery at all, so there is no recipient
--     to attribute it to: it is DELETED, not restored. Nobody had been told about it.
--   * a grouped delivery's grouping is lost; its member records come back as separate
--     rows, which is all the old schema could represent.
--   * `resolution_key` and `resolved_at` cleared on signal rows during 0256 stay cleared.
--     This is the one loss that applies even to a database nothing has written to since,
--     and it is what the pre-migration snapshot exists for.
--   * re-expanded rows other than the first carry NEW ids. Nothing references
--     `notifications.id`: `select conrelid::regclass from pg_constraint where confrelid =
--     'notifications'::regclass` returns no rows, and `issue_intervention_events` joins on
--     project and issue.

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_signal_has_no_resolve_state";
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_state_belongs_to_kind";
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_kind_is_known";
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_tier_is_known";

ALTER TABLE "notifications" ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE cascade;
ALTER TABLE "notifications" ADD COLUMN "read" boolean DEFAULT false NOT NULL;

-- The first delivery of each record keeps the record's own row.
UPDATE notifications n SET user_id = first.user_id, read = (first.read_at IS NOT NULL)
  FROM (
    SELECT DISTINCT ON (m.notification_id) m.notification_id, d.user_id, d.read_at
      FROM notification_delivery_members m
      JOIN notification_deliveries d ON d.id = m.delivery_id
     WHERE d.resolved_notice = false
     ORDER BY m.notification_id, d.created_at, d.id
  ) first
 WHERE n.id = first.notification_id;

-- Every OTHER delivery becomes its own row again, which is what the old schema meant.
INSERT INTO notifications (project_id, type, title, body, read, severity, resolution_key,
                           resolved_at, issue_id, secondary_issue_id, agent_session_id,
                           created_at, dedupe_key, user_id)
SELECT n.project_id, n.type, n.title, n.body, (d.read_at IS NOT NULL), n.severity,
       n.resolution_key, n.resolved_at, n.issue_id, n.secondary_issue_id, n.agent_session_id,
       n.created_at, n.dedupe_key, d.user_id
  FROM notification_delivery_members m
  JOIN notification_deliveries d ON d.id = m.delivery_id
  JOIN notifications n ON n.id = m.notification_id
 WHERE d.resolved_notice = false
   AND d.id <> (
     SELECT d2.id FROM notification_delivery_members m2
       JOIN notification_deliveries d2 ON d2.id = m2.delivery_id
      WHERE m2.notification_id = n.id AND d2.resolved_notice = false
      ORDER BY d2.created_at, d2.id LIMIT 1
   );

-- A record nobody was delivered cannot be represented: it is removed, and the notice says so.
DO $$
DECLARE undelivered bigint;
BEGIN
  DELETE FROM notifications WHERE user_id IS NULL;
  GET DIAGNOSTICS undelivered = ROW_COUNT;
  RAISE NOTICE 'ISS-1063 rollback: % record(s) had no delivery and could not be represented in the old schema; they were removed', undelivered;
END $$;

ALTER TABLE "notifications" ALTER COLUMN "user_id" SET NOT NULL;

DROP TABLE IF EXISTS "notification_delivery_members";
DROP TABLE IF EXISTS "notification_deliveries";
DROP TABLE IF EXISTS "notification_silences";

ALTER TABLE "notifications" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "tier";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "state";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "group_key";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "inhibited_by";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "pending_since";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "last_seen_at";

DROP INDEX IF EXISTS "notifications_ops_alert_active_uq";
DROP INDEX IF EXISTS "notifications_resolution_key_active_idx";
DROP INDEX IF EXISTS "notifications_group_key_idx";
DROP INDEX IF EXISTS "notifications_kind_state_idx";
CREATE INDEX "notifications_user_read_created_idx" ON "notifications" ("user_id","read","created_at");
CREATE INDEX "notifications_user_created_idx" ON "notifications" ("user_id","created_at");
CREATE INDEX "notifications_resolution_key_read_idx" ON "notifications" ("resolution_key","read");
CREATE UNIQUE INDEX "notifications_ops_alert_active_uq" ON "notifications" ("user_id","resolution_key")
  WHERE resolved_at IS NULL AND resolution_key IS NOT NULL AND type = 'ops_alert';
