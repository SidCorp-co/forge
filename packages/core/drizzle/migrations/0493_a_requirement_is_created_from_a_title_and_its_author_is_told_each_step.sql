-- A requirement is created from a title alone, and its author is told at every step change
-- (REQ-34 r2 BC-17, BC-21; Requirement lifecycle r15 start, rev_draft).
--
-- 1. A revision's reason is asked, never required. requirement_revisions.reason was NOT NULL with
--    a non-blank check, so no revision could be written before its reason was given. It is now
--    nullable: null means "not given yet", and the create asks it as a question on the
--    requirement (`requirements/reason-question.ts`). A reason that is given is still non-blank.
--    The revision guard used to freeze the reason once a revision left draft. It still freezes a
--    given reason. A null one may now be filled once, by the answer to its question, and is frozen
--    after that.
-- 2. requirements.told_step is the step its author was last told of (`requirements/step-notice.ts`).
--    Null means none was read yet. The first read records the step and tells nobody, so this
--    migration sends no notice for a step a requirement already stood at.
-- 3. requirement.transitioned is an outbox event type: each stored move of a requirement.
--
-- ROLLBACK: UPDATE requirement_revisions SET reason = '(not given)' WHERE reason IS NULL, which
-- invents a reason nobody gave; then put back NOT NULL, the old check and 0481's guard. DROP
-- COLUMN requirements.told_step. DELETE FROM outbox_event_types WHERE type =
-- 'requirement.transitioned'.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirement_revisions" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_revisions" DROP CONSTRAINT IF EXISTS "requirement_revisions_reason_chk";--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_reason_chk" CHECK ("requirement_revisions"."reason" IS NULL OR "requirement_revisions"."reason" ~ '[^[:space:]]');--> statement-breakpoint
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
    OR (NEW."reason" IS DISTINCT FROM OLD."reason" AND NOT (OLD."reason" IS NULL AND NEW."reason" IS NOT NULL))
    OR NEW."base_revision" IS DISTINCT FROM OLD."base_revision"
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
END $$;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "told_step" text;--> statement-breakpoint
ALTER TABLE "requirements" DROP CONSTRAINT IF EXISTS "requirements_told_step_chk";--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_told_step_chk" CHECK ("requirements"."told_step" IS NULL OR "requirements"."told_step" IN ('draft', 'agreed', 'in_delivery', 'delivered', 'accepted', 'deferred', 'dropped'));--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('requirement.transitioned') ON CONFLICT DO NOTHING;
