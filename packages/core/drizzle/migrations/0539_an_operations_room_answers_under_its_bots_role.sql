-- A Rocket.Chat room answered for the team under its bot's role (REQ-75 r4 BC-20..BC-24), and what a
-- support group's asker confirms named for what it is:
--   support_rooms      gains `kind` (support | operations) and, for an operations room, its `scope`
--                      (forge | project). An operations binding attaches several rooms, each with its
--                      own session, so a room is one per (binding, rid) rather than one per binding.
--   support_proposals  is support_fixes renamed: a fix and a Feedback filing both wait on their asker
--                      there, under one code space per room, and `kind` (fix | filing) says which. A
--                      filing was stored as a fix under the reserved tool name `forge:record`; it now
--                      holds kind `filing` and no tool.
--   support_actions    fix_id becomes proposal_id, and `operation` (an operations room's act) joins
--                      the kinds.
-- Every existing room is a support group (kind defaults to 'support', scope stays null), every
-- binding holds one room (support_rooms_binding_uq), so the wider unique index admits every row; every
-- existing proposal is a fix or a `forge:record` filing, so the kind check admits every row.
--
-- ROLLBACK: rename support_proposals back to support_fixes (constraints and indexes with it), SET
-- tool = 'forge:record' WHERE kind = 'filing', SET NOT NULL on tool, drop kind; rename proposal_id
-- back to fix_id; once no room is an operations room, drop kind and scope from support_rooms and
-- restore support_rooms_binding_uq on (binding_id); restore support_actions_kind_chk without
-- 'operation' once no row holds it.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "support_rooms" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'support' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_rooms" ADD COLUMN IF NOT EXISTS "scope" text;--> statement-breakpoint
ALTER TABLE "support_rooms" DROP CONSTRAINT IF EXISTS "support_rooms_kind_chk";--> statement-breakpoint
ALTER TABLE "support_rooms" ADD CONSTRAINT "support_rooms_kind_chk" CHECK ("support_rooms"."kind" IN ('support', 'operations'));--> statement-breakpoint
ALTER TABLE "support_rooms" DROP CONSTRAINT IF EXISTS "support_rooms_scope_chk";--> statement-breakpoint
ALTER TABLE "support_rooms" ADD CONSTRAINT "support_rooms_scope_chk" CHECK (("support_rooms"."kind" = 'operations') = ("support_rooms"."scope" IS NOT NULL) AND ("support_rooms"."scope" IS NULL OR "support_rooms"."scope" IN ('forge', 'project')));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_rooms_binding_rid_uq" ON "support_rooms" USING btree ("binding_id","rid");--> statement-breakpoint
DROP INDEX IF EXISTS "support_rooms_binding_uq";--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.support_fixes') IS NOT NULL AND to_regclass('public.support_proposals') IS NULL THEN
    ALTER TABLE "support_fixes" RENAME TO "support_proposals";
  END IF;
  FOR r IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.support_proposals'::regclass AND conname LIKE 'support\_fixes%' LOOP
    EXECUTE format('ALTER TABLE "support_proposals" RENAME CONSTRAINT %I TO %I',
      r.conname, 'support_proposals' || substr(r.conname, length('support_fixes') + 1));
  END LOOP;
  FOR r IN SELECT indexname FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'support_proposals' AND indexname LIKE 'support\_fixes%' LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I',
      r.indexname, 'support_proposals' || substr(r.indexname, length('support_fixes') + 1));
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'support_actions' AND column_name = 'fix_id') THEN
    ALTER TABLE "support_actions" RENAME COLUMN "fix_id" TO "proposal_id";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "support_proposals" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'fix' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_proposals" ALTER COLUMN "tool" DROP NOT NULL;--> statement-breakpoint
UPDATE "support_proposals" SET "kind" = 'filing', "tool" = NULL WHERE "tool" = 'forge:record';--> statement-breakpoint
ALTER TABLE "support_proposals" DROP CONSTRAINT IF EXISTS "support_proposals_kind_chk";--> statement-breakpoint
ALTER TABLE "support_proposals" ADD CONSTRAINT "support_proposals_kind_chk" CHECK ("support_proposals"."kind" IN ('fix', 'filing') AND ("support_proposals"."kind" = 'fix') = ("support_proposals"."tool" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_kind_chk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_kind_chk" CHECK ("support_actions"."kind" IN ('message_in', 'reply', 'diagnose', 'fix_proposed', 'fix_confirmed', 'fix_ran', 'fix_failed', 'fix_declined', 'fix_expired', 'feedback_recorded', 'progress_posted', 'refused', 'operation'));
