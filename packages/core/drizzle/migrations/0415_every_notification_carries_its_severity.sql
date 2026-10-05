-- notifications.severity was nullable for rows written before ISS-510. Every writer since stamps
-- the type's contract severity (packages/contracts/src/notifications.ts:NOTIFICATION_CONTRACT) or an
-- emitter's own, so the legacy rows are backfilled from their type's contract default and the column
-- becomes NOT NULL; the read-time default for a missing severity is deleted with it.
--
-- ROLLBACK: ALTER TABLE notifications ALTER COLUMN severity DROP NOT NULL. The backfilled values
-- stay; they are what a reader already derived for those rows.
--
-- A NULL-severity row whose type the contract does not declare aborts this migration naming the
-- type: there is no default to take for it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE "notifications" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "notifications" SET "severity" = CASE "type"
  WHEN 'issue_status_changed' THEN 'info'
  WHEN 'mention' THEN 'info'
  WHEN 'pipeline_wedge' THEN 'error'
  WHEN 'invitation_received' THEN 'warning'
  WHEN 'intake_pending' THEN 'info'
  WHEN 'schedule_report' THEN 'info'
  WHEN 'issue_stranded' THEN 'warning'
  WHEN 'retry_rescue_threshold' THEN 'warning'
  WHEN 'ops_alert' THEN 'warning'
  WHEN 'channel_document_published' THEN 'info'
  WHEN 'channel_thread_held' THEN 'warning'
  WHEN 'channel_gate_pending' THEN 'warning'
  WHEN 'contract_version_published' THEN 'info'
  WHEN 'requirement_delivered' THEN 'info'
  WHEN 'feedback_verify_asked' THEN 'info'
END
WHERE "severity" IS NULL;--> statement-breakpoint
DO $$
DECLARE bad text;
BEGIN
  SELECT "type" INTO bad FROM notifications WHERE severity IS NULL LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'NOTIFICATION_SEVERITY_UNMAPPED: notifications of type % hold no severity and the contract declares no default for that type, so this migration writes nothing until they are repaired', bad USING ERRCODE = 'check_violation';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "severity" SET NOT NULL;
