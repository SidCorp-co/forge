-- REQ-50 r2 (owner ruling 2026-10-23): lessons are internal to Forge. The steward and core settle every
-- lesson, every confusion and every correction, and no person approves, keeps, dismisses or records
-- one. This takes the columns and the chat card that only a person's act wrote out of the schema,
-- turns a person's dismissal of a correction into the steward's rejection of one, and gives a
-- confusion the two columns the steward's settlement needs. No row is deleted and no value dropped.
--
-- 1. Chat cards. A chat no longer holds a lesson confusion for a person to record: the Assistant's
--    `forge_lesson_confusion` goes straight to the steward. Each card of kind `lesson_confusion` still
--    pending is settled `declined` (the one settled status that claims no agreement), by the project's
--    steward account where one was minted, with the reason in `failure`; where none was minted,
--    `decided_by` stays null and the reason says so. Nothing is written for the card.
--    The kind CHECK then admits `lesson_confusion` only on a settled card. This is not a full drop of
--    the kind on purpose: a card already recorded, failed or declined is history of what a chat did,
--    and no other kind can represent it, so dropping the kind would mean deleting those rows. The
--    narrowed CHECK refuses every new card of that kind (each card is written pending), keeps the
--    history representable, and deletes nothing. The rows stay in the table and no read serves them
--    (`assistant/agreement/store.ts` reads only the kinds a chat holds now), since no screen shows a
--    lesson confusion (BC-9). Any row the CHECK still cannot represent aborts the deploy by its id.
-- 2. `lessons.retire_reason`, `retire_proposed_at` and `kept_at` go: the steward retires a due lesson
--    itself. `kept_at` restarted the 30-day unused clock, which now reads `approved_at` and
--    `last_applied_at` alone; a row whose `kept_at` is later than both has it folded into
--    `last_applied_at` (the one column only that clock reads), named in a NOTICE, so no row's clock
--    moves.
-- 3. A correction that is not one is still a state, which the steward now settles: `dismissed_at` and
--    `dismissed_by` are renamed `rejected_at` and `rejected_by` with their values (and the foreign key
--    with them), and `rejected_reason` is added. Each row a person dismissed keeps who and when, and
--    its reason says a person dismissed it before the steward took corrections over. The CHECK
--    `corrections_rejected_chk` then holds a reason on every rejected row, and
--    `corrections_unlinked_idx` is rebuilt to leave rejected rows out, as it left dismissed ones out.
-- 4. `lesson_confusions.reason` keeps why the steward kept, edited or retired the lesson, and
--    `tried_at` when it last tried and left the confusion waiting, so each pass reaches the confusions
--    least recently tried first, on one lesson as across lessons.
--
-- ROLLBACK: add `lessons.retire_reason text`, `retire_proposed_at timestamptz`, `kept_at timestamptz`
-- and `lessons_retire_chk` as 0510 wrote it; drop `corrections_rejected_chk` and
-- `corrections.rejected_reason`, rename `rejected_at`, `rejected_by` and
-- `corrections_rejected_by_users_id_fk` back to their `dismissed` names, and rebuild
-- `corrections_unlinked_idx` with `AND dismissed_at IS NULL`; drop `lesson_confusions.reason` and
-- `tried_at`; restore `chat_proposals_kind_chk` to admit `lesson_confusion` in any status. A folded
-- `kept_at` stays in `last_applied_at`, a card settled here stays declined, and a correction the
-- steward rejected after 0522 reads as dismissed (its reason is lost with the column).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
UPDATE "chat_proposals" AS cp
   SET "status" = 'declined',
       "decided_at" = now(),
       "decided_by" = sa."user_id",
       "failure" = CASE
         WHEN sa."user_id" IS NULL THEN 'Settled by migration 0522 for the steward: a lesson confusion from chat now goes straight to the steward, which settles it, and no person records one (REQ-50 BC-5, BC-9). This project has no steward account yet, so none is named as deciding it. Nothing was written; raise it again in chat if it still holds.'
         ELSE 'Settled by the steward at migration 0522: a lesson confusion from chat now goes straight to the steward, which settles it, and no person records one (REQ-50 BC-5, BC-9). Nothing was written; raise it again in chat if it still holds.'
       END
  FROM "chat_proposals" AS c
  LEFT JOIN "steward_accounts" AS sa ON sa."project_id" = c."project_id"
 WHERE cp."id" = c."id" AND cp."kind" = 'lesson_confusion' AND cp."status" = 'pending';--> statement-breakpoint
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg("id"::text || ' (' || "kind" || ', ' || "status" || ')', ', ' ORDER BY "id")
    INTO bad
    FROM "chat_proposals"
   WHERE NOT ("kind" IN ('feedback', 'requirement_draft', 'requirement_revision', 'comment', 'attachment', 'memory_note', 'preferences', 'report_save', 'issue_change', 'requirement_link', 'project_change')
              OR ("kind" = 'lesson_confusion' AND "status" <> 'pending'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0522: chat_proposals rows the narrowed kind CHECK cannot represent: %', bad;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "chat_proposals" DROP CONSTRAINT IF EXISTS "chat_proposals_kind_chk";--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_kind_chk" CHECK ("chat_proposals"."kind" IN ('feedback', 'requirement_draft', 'requirement_revision', 'comment', 'attachment', 'memory_note', 'preferences', 'report_save', 'issue_change', 'requirement_link', 'project_change') OR ("chat_proposals"."kind" IN ('lesson_confusion') AND "chat_proposals"."status" <> 'pending'));--> statement-breakpoint
DO $$
DECLARE
  folded record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'lessons' AND column_name = 'kept_at'
  ) THEN
    FOR folded IN
      EXECUTE 'UPDATE "lessons" SET "last_applied_at" = "kept_at"
                WHERE "kept_at" IS NOT NULL
                  AND (GREATEST("approved_at", "last_applied_at") IS NULL
                       OR "kept_at" > GREATEST("approved_at", "last_applied_at"))
            RETURNING "id", "project_id", "number", "kept_at"'
    LOOP
      RAISE NOTICE '0522: L-% (lesson %, project %) was kept at %; its unused clock now reads that from last_applied_at',
        folded.number, folded.id, folded.project_id, folded.kept_at;
    END LOOP;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_retire_chk";--> statement-breakpoint
ALTER TABLE "lessons" DROP COLUMN IF EXISTS "retire_reason";--> statement-breakpoint
ALTER TABLE "lessons" DROP COLUMN IF EXISTS "retire_proposed_at";--> statement-breakpoint
ALTER TABLE "lessons" DROP COLUMN IF EXISTS "kept_at";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'corrections' AND column_name = 'dismissed_at'
  ) THEN
    ALTER TABLE "corrections" RENAME COLUMN "dismissed_at" TO "rejected_at";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'corrections' AND column_name = 'dismissed_by'
  ) THEN
    ALTER TABLE "corrections" RENAME COLUMN "dismissed_by" TO "rejected_by";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'corrections_dismissed_by_users_id_fk') THEN
    ALTER TABLE "corrections" RENAME CONSTRAINT "corrections_dismissed_by_users_id_fk" TO "corrections_rejected_by_users_id_fk";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "corrections" ADD COLUMN IF NOT EXISTS "rejected_reason" text;--> statement-breakpoint
UPDATE "corrections"
   SET "rejected_reason" = 'A person dismissed this correction before the steward took corrections over (REQ-50 r2, migration 0522). It stays rejected and never feeds a lesson.'
 WHERE "rejected_at" IS NOT NULL AND "rejected_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_rejected_chk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_rejected_chk" CHECK (("corrections"."rejected_at" IS NULL) = ("corrections"."rejected_reason" IS NULL) AND ("corrections"."rejected_reason" IS NULL OR length(btrim("corrections"."rejected_reason")) >= 1));--> statement-breakpoint
DROP INDEX IF EXISTS "corrections_unlinked_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corrections_unlinked_idx" ON "corrections" USING btree ("project_id") WHERE lesson_id IS NULL AND rejected_at IS NULL;--> statement-breakpoint
ALTER TABLE "lesson_confusions" ADD COLUMN IF NOT EXISTS "reason" text;--> statement-breakpoint
ALTER TABLE "lesson_confusions" ADD COLUMN IF NOT EXISTS "tried_at" timestamp with time zone;
