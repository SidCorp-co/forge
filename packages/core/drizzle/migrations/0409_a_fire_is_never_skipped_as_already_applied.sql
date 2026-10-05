-- automation `route`: no router writes the skip reason already-applied since the improvement-message
-- templates went (ISS-208), so the value leaves the reason CHECK. A row still reading it aborts the
-- migration by name rather than being rewritten.
--
-- ROLLBACK: re-add 'already-applied' to schedule_runs_reason_chk.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE stray record;
BEGIN
  SELECT r."id", r."created_at" INTO stray FROM "schedule_runs" r WHERE r."reason" = 'already-applied' ORDER BY r."created_at", r."id" LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'SCHEDULE_RUN_REASON_RETIRED: schedule_runs row % (fired %) reads reason already-applied, which no router writes since the improvement-message templates were deleted (ISS-208), so this migration writes nothing until that row is repaired', stray."id", stray."created_at" USING ERRCODE = 'check_violation';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT "schedule_runs_reason_chk";--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_reason_chk" CHECK (("schedule_runs"."status" = 'skipped') = ("schedule_runs"."reason" IS NOT NULL) AND ("schedule_runs"."reason" IS NULL OR "schedule_runs"."reason" IN ('no-device', 'project-not-found', 'nothing-to-do', 'gate-refused')));
