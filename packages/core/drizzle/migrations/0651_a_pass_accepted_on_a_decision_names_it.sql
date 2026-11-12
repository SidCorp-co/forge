-- ISS-1223 (catalog-api 0.6.0, REQ-36 BC-22). A project's owner accepted criteria with no runtime
-- verdict as proven by the suite at a named commit, recorded as a `decision` on each issue, and a
-- release judged on a testing environment counted no commit verdict, so the master was asked for a
-- judging run every pass. A commit pass may now name that decision:
--   1. criterion_verdicts.accepted_on: the `decision` record on the verdict's own issue it names
--      (`issues/criteria/verdict-acceptance.ts` refuses any other by name). Null on every row today,
--      so every verdict standing today reads exactly as before; no row is changed.
--   2. Only a commit pass names one.
--
-- ROLLBACK (only while no row names one):
--   ALTER TABLE criterion_verdicts DROP CONSTRAINT criterion_verdicts_accepted_chk;
--   ALTER TABLE criterion_verdicts DROP COLUMN accepted_on;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD COLUMN IF NOT EXISTS "accepted_on" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'criterion_verdicts_accepted_on_activity_log_id_fk') THEN
    ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_accepted_on_activity_log_id_fk"
      FOREIGN KEY ("accepted_on") REFERENCES "public"."activity_log"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'criterion_verdicts_accepted_chk') THEN
    ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_accepted_chk"
      CHECK ("accepted_on" IS NULL OR ("verdict" = 'pass' AND "identity_kind" = 'commit'));
  END IF;
END $$;
