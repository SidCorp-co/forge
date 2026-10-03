-- ISS-56 — comments carry an intent, forge-record kinds become typed activity events, and the
-- agent friction table is renamed so the word "feedback" is free for FB-n (ISS-59).
-- Idempotent throughout: every statement converges if the file is re-run on a partly applied DB.

-- 1. Comment intent. A system write that declares nothing is a note.
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "intent" text DEFAULT 'note' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_intent_chk') THEN
    ALTER TABLE "comments" ADD CONSTRAINT "comments_intent_chk"
      CHECK ("comments"."intent" IN ('question', 'decision', 'note'));
  END IF;
END $$;--> statement-breakpoint
-- Backfill: every comment the old inbox rule could count as owed — a person's, carrying no
-- record — is a question, so no thread goes quiet; the rest stay notes.
UPDATE "comments" c SET "intent" = 'question'
WHERE c."intent" = 'note'
  AND c."author_device_id" IS NULL
  AND c."body" NOT LIKE '%forge-record%'
  AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = c."author_id" AND u."kind" <> 'agent');--> statement-breakpoint

-- 2. Record events are activity_log rows with action `record.<kind>`, from a closed set.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_record_kind_chk') THEN
    ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_record_kind_chk" CHECK ("activity_log"."action" NOT LIKE 'record.%' OR "activity_log"."action" IN ('record.verdict', 'record.transition', 'record.landing', 'record.park', 'record.correction', 'record.fold', 'record.routed', 'record.gap', 'record.baseline', 'record.decision', 'record.question', 'record.answer', 'record.confirmation', 'record.superseded', 'record.review', 'record.finding', 'record.triage', 'record.folded', 'record.declined', 'record.wave', 'record.verification', 'record.digest'));
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_record_issue_idx" ON "activity_log" USING btree ("issue_id","action","created_at") WHERE "activity_log"."action" LIKE 'record.%';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "activity_log_record_comment_uq" ON "activity_log" USING btree ("dedupe_key") WHERE "activity_log"."dedupe_key" LIKE 'record-comment:%';--> statement-breakpoint

-- 3. feedback_reports → agent_reports, with every constraint and index named after it.
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.feedback_reports') IS NOT NULL AND to_regclass('public.agent_reports') IS NULL THEN
    ALTER TABLE "feedback_reports" RENAME TO "agent_reports";
  END IF;
  FOR r IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.agent_reports'::regclass AND conname LIKE 'feedback\_reports%' LOOP
    EXECUTE format('ALTER TABLE "agent_reports" RENAME CONSTRAINT %I TO %I',
      r.conname, 'agent_reports' || substr(r.conname, length('feedback_reports') + 1));
  END LOOP;
  FOR r IN SELECT indexname FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'agent_reports' AND indexname LIKE 'feedback\_reports%' LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I',
      r.indexname, 'agent_reports' || substr(r.indexname, length('feedback_reports') + 1));
  END LOOP;
END $$;
