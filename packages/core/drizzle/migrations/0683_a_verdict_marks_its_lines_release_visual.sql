-- ISS-1308. A release page showed a clip only on requirement highlights, which no recent release
-- grew, so every release read as text although its judges had attached clips and shots. A verdict
-- now marks which of its issue's attachments show that issue's line on the release page: a desktop
-- frame, a phone frame, the still a clip opens on and the clip's length as its recorder wrote it
-- (`issues/criteria/release-visual-mark.ts`). Core never picks a file: each is the judge's mark, and
-- a deleted attachment drops its mark with it.
-- `without_clip` keeps the why a judgement of an observable criterion cites no clip (REQ-40 BC-4),
-- written until now only into its kernel record, so the release page reads a line the judge said has
-- no visual apart from one that owes one; earlier verdicts take it back from their records.
--
-- ROLLBACK: ALTER TABLE "criterion_verdicts" DROP COLUMN IF EXISTS "visual_desktop_id",
--   DROP COLUMN IF EXISTS "visual_phone_id", DROP COLUMN IF EXISTS "visual_still_id",
--   DROP COLUMN IF EXISTS "visual_seconds", DROP COLUMN IF EXISTS "without_clip";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "criterion_verdicts"
  ADD COLUMN IF NOT EXISTS "visual_desktop_id" uuid REFERENCES "issue_attachments"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "visual_phone_id" uuid REFERENCES "issue_attachments"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "visual_still_id" uuid REFERENCES "issue_attachments"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "visual_seconds" integer,
  ADD COLUMN IF NOT EXISTS "without_clip" text;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP CONSTRAINT IF EXISTS "criterion_verdicts_visual_seconds_chk";--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_visual_seconds_chk"
  CHECK ("visual_seconds" IS NULL OR ("visual_seconds" >= 1 AND "visual_seconds" <= 3600));--> statement-breakpoint
UPDATE "criterion_verdicts" v
   SET "without_clip" = r.why
  FROM (
    SELECT (SELECT f->>'value' FROM jsonb_array_elements(a.payload->'fields') f WHERE f->>'key' = 'verdict-id' LIMIT 1) AS verdict_id,
           (SELECT f->>'value' FROM jsonb_array_elements(a.payload->'fields') f WHERE f->>'key' = 'without-clip' LIMIT 1) AS why
      FROM "activity_log" a
     WHERE a.action = 'record.verdict'
       AND jsonb_typeof(a.payload->'fields') = 'array'
       AND a.payload->'fields' @> '[{"key":"without-clip"}]'
  ) r
 WHERE r.verdict_id = v.id::text AND r.why IS NOT NULL AND v.without_clip IS NULL;
