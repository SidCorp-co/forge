-- A draft revision nobody touched for a week, answered "drop" on Forge's merge-or-drop question,
-- is withdrawn (REQ-41 BC-12; orchestrator ruling 2026-10-09: a stale draft revision may be
-- discarded). `withdrawn` is a terminal revision state reachable only from `draft`, with the reason,
-- who and when on the row. It is not open, so the one-open-revision index lets the next draft be
-- written, and its content stays frozen like every revision that left draft.
--
-- ROLLBACK: UPDATE nothing back (a withdrawn revision has no state to return to); restore the
-- guard from 0424; DROP CONSTRAINT requirement_revisions_withdrawn_chk; rebuild
-- requirement_revisions_state_chk without 'withdrawn' (refused while a withdrawn row exists);
-- DROP COLUMN withdrawn_reason, withdrawn_at, withdrawn_by.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN IF NOT EXISTS "withdrawn_reason" text;
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN IF NOT EXISTS "withdrawn_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN IF NOT EXISTS "withdrawn_by" uuid REFERENCES "users"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "requirement_revisions" DROP CONSTRAINT IF EXISTS "requirement_revisions_state_chk";
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_state_chk" CHECK ("requirement_revisions"."state" IN ('draft', 'proposed', 'current', 'superseded', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE "requirement_revisions" DROP CONSTRAINT IF EXISTS "requirement_revisions_withdrawn_chk";
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_withdrawn_chk" CHECK ("requirement_revisions"."state" <> 'withdrawn' OR ("requirement_revisions"."withdrawn_reason" ~ '[^[:space:]]' AND "requirement_revisions"."withdrawn_at" IS NOT NULL AND "requirement_revisions"."withdrawn_by" IS NOT NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "requirement_revision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id") THEN
      RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % is evidence and is never deleted; only deleting its requirement removes it', OLD."requirement_id", OLD."revision" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."requirement_id" <> OLD."requirement_id" OR NEW."revision" <> OLD."revision" THEN
    RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % keeps its identity', OLD."requirement_id", OLD."revision" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" <> 'draft' AND (
       NEW."spec" IS DISTINCT FROM OLD."spec" OR NEW."spec_version" IS DISTINCT FROM OLD."spec_version"
    OR NEW."tldr" IS DISTINCT FROM OLD."tldr" OR NEW."change_summary" IS DISTINCT FROM OLD."change_summary"
    OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."base_revision" IS DISTINCT FROM OLD."base_revision"
    OR NEW."author_id" IS DISTINCT FROM OLD."author_id"
    OR NEW."author_agency" IS DISTINCT FROM OLD."author_agency") THEN
    RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % is %, so its content is frozen; write a new revision', OLD."requirement_id", OLD."revision", OLD."state" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" = 'withdrawn' AND (
       NEW."withdrawn_reason" IS DISTINCT FROM OLD."withdrawn_reason"
    OR NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at"
    OR NEW."withdrawn_by" IS DISTINCT FROM OLD."withdrawn_by") THEN
    RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % is withdrawn, and why, by whom and when stay as written', OLD."requirement_id", OLD."revision" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" <> OLD."state" AND (OLD."state", NEW."state") NOT IN (
       ('draft', 'proposed'), ('proposed', 'draft'), ('proposed', 'current'), ('current', 'superseded'),
       ('draft', 'withdrawn')) THEN
    RAISE EXCEPTION 'REVISION_STATE_TRANSITION: requirement % revision % cannot move % -> %; a revision moves draft, proposed, current, superseded, and only a draft is withdrawn', OLD."requirement_id", OLD."revision", OLD."state", NEW."state" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
