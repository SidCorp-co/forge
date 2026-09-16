-- ISS-1063 — one notifications table carried three record lifecycles and one person's
-- read state. This splits the record from the delivery and gives every row a kind.
--
-- Measured on the production replica 2026-09-16 20:45Z, and every count below is what
-- this migration is sized against: 11037 rows over 14 users; 5444 `issue_status_changed`
-- of which 1771 wrongly carried a condition's resolution key; 2997 `issue_stranded` rows
-- that are 545 conditions told to their project's admins one row each.

--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "channel" text DEFAULT 'bell' NOT NULL,
  "group_key" text,
  "title" text,
  "read_at" timestamp with time zone,
  "resolved_notice" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_members" (
  "delivery_id" uuid NOT NULL REFERENCES "notification_deliveries"("id") ON DELETE cascade,
  "notification_id" uuid NOT NULL REFERENCES "notifications"("id") ON DELETE cascade,
  CONSTRAINT "notification_delivery_members_delivery_id_notification_id_pk" PRIMARY KEY ("delivery_id", "notification_id")
);
--> statement-breakpoint
CREATE TABLE "notification_silences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "type" text,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE cascade,
  "resolution_key" text,
  "reason" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "inhibited_by" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "pending_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint

-- A row whose type this taxonomy cannot place ABORTS the migration naming the row.
-- `comment_added` and `agent_completed` were removed from the taxonomy in the same change
-- because neither had an emitter anywhere; both read zero rows on the replica, and this is
-- what proves it rather than assuming it.
DO $$
DECLARE offending record;
BEGIN
  SELECT id, type, created_at INTO offending FROM notifications
   WHERE type NOT IN ('issue_status_changed','mention','pm_escalation','pipeline_wedge',
                      'invitation_received','intake_pending','schedule_report',
                      'reconcile_gate_pending','issue_stranded','retry_rescue_threshold','ops_alert')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ISS-1063: notification % (type %, created %) has no kind in the new taxonomy. Decide what that type is before this migration runs; it is not cleaned away.',
      offending.id, offending.type, offending.created_at;
  END IF;
END $$;--> statement-breakpoint

UPDATE notifications SET
  kind = CASE type
    WHEN 'issue_status_changed' THEN 'signal'
    WHEN 'mention' THEN 'signal'
    WHEN 'schedule_report' THEN 'signal'
    WHEN 'pipeline_wedge' THEN 'condition'
    WHEN 'issue_stranded' THEN 'condition'
    WHEN 'retry_rescue_threshold' THEN 'condition'
    WHEN 'ops_alert' THEN 'condition'
    ELSE 'task'
  END,
  tier = CASE type
    WHEN 'issue_status_changed' THEN 'log'
    WHEN 'schedule_report' THEN 'log'
    WHEN 'pm_escalation' THEN 'page'
    WHEN 'pipeline_wedge' THEN 'page'
    ELSE 'ticket'
  END;--> statement-breakpoint

UPDATE notifications SET
  state = CASE
    WHEN kind = 'signal' THEN 'emitted'
    WHEN kind = 'condition' AND resolved_at IS NOT NULL THEN 'resolved'
    WHEN kind = 'condition' THEN 'firing'
    WHEN resolved_at IS NOT NULL THEN 'done'
    ELSE 'open'
  END,
  last_seen_at = CASE WHEN kind = 'condition' THEN created_at END,
  pending_since = CASE WHEN kind = 'condition' THEN created_at END;--> statement-breakpoint

-- A signal carries no resolve state, because an event cannot stop having happened. This
-- is the one thing the migration RE-LABELS rather than carries, and it is the change the
-- rollback cannot undo: 3914 of the 5663 rows the owner read as "still open" were this.
DO $$
DECLARE relabelled bigint;
BEGIN
  UPDATE notifications SET resolution_key = NULL, resolved_at = NULL WHERE kind = 'signal'
    AND (resolution_key IS NOT NULL OR resolved_at IS NOT NULL);
  GET DIAGNOSTICS relabelled = ROW_COUNT;
  RAISE NOTICE 'ISS-1063: % signal row(s) had a resolution key or a resolved timestamp cleared', relabelled;
  RAISE NOTICE 'ISS-1063: kinds — % signal, % condition, % task',
    (SELECT count(*) FROM notifications WHERE kind = 'signal'),
    (SELECT count(*) FROM notifications WHERE kind = 'condition'),
    (SELECT count(*) FROM notifications WHERE kind = 'task');
END $$;--> statement-breakpoint

ALTER TABLE "notifications" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "tier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "state" SET NOT NULL;--> statement-breakpoint

-- Every row becomes a delivery of itself, carrying the recipient and the read state it
-- used to hold in the same row.
INSERT INTO notification_deliveries (id, user_id, channel, read_at, created_at)
SELECT id, user_id, 'bell', CASE WHEN read THEN created_at END, created_at FROM notifications;--> statement-breakpoint
INSERT INTO notification_delivery_members (delivery_id, notification_id)
SELECT id, id FROM notifications;--> statement-breakpoint

-- CONSOLIDATION, and only of recipient copies.
--
-- A bucket is the condition rows sharing one (type, resolution_key) whose created_at are
-- no more than 60 seconds apart — recipient copies are written in one loop and every
-- renotify window in this codebase is 24 hours, so the gap separates them cleanly. A
-- bucket is consolidated ONLY when every row in it carries a distinct user_id, i.e. only
-- when it is purely a fan-out. Anything else is left exactly as it is.
--
-- That narrowness is load-bearing: `issue_intervention_events` (VISION metric ②) counts
-- one row per `pipeline_wedge` straight off this table, and `pipeline_wedge` fans out to
-- one recipient, so no wedge bucket is a fan-out and the metric cannot move. Measured on
-- the replica: issue_stranded 2997 rows → 545 records, reconcile_gate_pending 5 → 1,
-- ops_alert 265 and pipeline_wedge 1981 untouched.
DO $$
DECLARE offending record;
DECLARE merged bigint;
BEGIN
  CREATE TEMP TABLE iss1063_buckets AS
  WITH gaps AS (
    SELECT id, type, resolution_key, user_id, project_id, issue_id, created_at,
           CASE WHEN lag(created_at) OVER w IS NULL
                  OR created_at - lag(created_at) OVER w > interval '60 seconds'
                THEN 1 ELSE 0 END AS starts
      FROM notifications
     WHERE kind = 'condition' AND resolution_key IS NOT NULL
    WINDOW w AS (PARTITION BY type, resolution_key ORDER BY created_at)
  ), bucketed AS (
    SELECT *, sum(starts) OVER (PARTITION BY type, resolution_key ORDER BY created_at
                                ROWS UNBOUNDED PRECEDING) AS bucket
      FROM gaps
  )
  SELECT type, resolution_key, bucket,
         count(*) AS rows_in, count(DISTINCT user_id) AS users,
         count(DISTINCT coalesce(project_id::text,'~')) AS projects,
         count(DISTINCT coalesce(issue_id::text,'~')) AS issues,
         (array_agg(id ORDER BY created_at))[1] AS survivor,
         array_agg(id ORDER BY created_at) AS ids
    FROM bucketed GROUP BY type, resolution_key, bucket;

  SELECT * INTO offending FROM iss1063_buckets
   WHERE rows_in > 1 AND rows_in = users AND (projects > 1 OR issues > 1) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ISS-1063: the recipient copies under (%, %) disagree about which project or issue they are about (ids %). Two rows that are not the same fact cannot become one record; decide what they are before this migration runs.',
      offending.type, offending.resolution_key, offending.ids;
  END IF;

  -- Each recipient's copy becomes a DELIVERY of the survivor. The delivery row already
  -- exists (every notification became one above) and keeps its own read state; only what
  -- it points at moves. Deleting the non-survivors then cascades their old member rows.
  INSERT INTO notification_delivery_members (delivery_id, notification_id)
  SELECT m.delivery_id, b.survivor
    FROM notification_delivery_members m
    JOIN iss1063_buckets b ON m.notification_id = ANY(b.ids)
   WHERE b.rows_in > 1 AND b.rows_in = b.users AND m.notification_id <> b.survivor
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS merged = ROW_COUNT;

  DELETE FROM notifications n USING iss1063_buckets b
   WHERE b.rows_in > 1 AND b.rows_in = b.users
     AND n.id = ANY(b.ids) AND n.id <> b.survivor;

  RAISE NOTICE 'ISS-1063: % recipient copies folded into their condition''s single record', merged;
  DROP TABLE iss1063_buckets;
END $$;--> statement-breakpoint

-- After consolidation there must be exactly one ACTIVE ops_alert per resolution key, or
-- the unique index below fails with a message about an index rather than about the data.
-- Say it in the data's own terms instead.
DO $$
DECLARE offending record;
BEGIN
  SELECT resolution_key, count(*) AS n INTO offending FROM notifications
   WHERE type = 'ops_alert' AND resolved_at IS NULL AND resolution_key IS NOT NULL
   GROUP BY resolution_key HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ISS-1063: % active ops_alert rows share the resolution key %, and the record layer holds one per key. Resolve or merge them before this migration runs.',
      offending.n, offending.resolution_key;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "notifications" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "read";--> statement-breakpoint

DROP INDEX IF EXISTS "notifications_user_read_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "notifications_user_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "notifications_resolution_key_read_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "notifications_ops_alert_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_ops_alert_active_uq" ON "notifications" ("resolution_key")
  WHERE resolved_at IS NULL AND resolution_key IS NOT NULL AND type = 'ops_alert';--> statement-breakpoint
CREATE INDEX "notifications_resolution_key_active_idx" ON "notifications" ("resolution_key","resolved_at");--> statement-breakpoint
CREATE INDEX "notifications_group_key_idx" ON "notifications" ("group_key");--> statement-breakpoint
CREATE INDEX "notifications_kind_state_idx" ON "notifications" ("kind","state");--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_created_idx" ON "notification_deliveries" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_read_idx" ON "notification_deliveries" ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_user_group_uq" ON "notification_deliveries" ("user_id","group_key","resolved_notice") WHERE group_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_delivery_members_notification_idx" ON "notification_delivery_members" ("notification_id");--> statement-breakpoint
CREATE INDEX "notification_silences_active_idx" ON "notification_silences" ("expires_at","type");--> statement-breakpoint

-- A kind means something, and these are what make it mean it.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_signal_has_no_resolve_state"
  CHECK (kind <> 'signal' OR (resolution_key IS NULL AND resolved_at IS NULL));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_state_belongs_to_kind"
  CHECK (
    (kind = 'signal' AND state IN ('emitted','expired'))
    OR (kind = 'condition' AND state IN ('pending','firing','inhibited','resolved'))
    OR (kind = 'task' AND state IN ('open','acknowledged','done','dismissed'))
  );--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_is_known"
  CHECK (kind IN ('signal','condition','task'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tier_is_known"
  CHECK (tier IN ('page','ticket','log'));
