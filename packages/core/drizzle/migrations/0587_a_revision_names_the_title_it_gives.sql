-- A requirement is retitled by a revision a person agrees (ISS-829, FB-408). The title used to be
-- fixed at creation: PATCH takes only the owner, and no route renamed a requirement whose agreed
-- criteria had outgrown its title.
--
-- 1. requirement_revisions.title is the title the revision gives the requirement. Every revision
--    written from now on stores one: revision 1 the title it was created with, a later revision the
--    one it names or else the head's, carried as its kind is. Accepting a revision makes its title
--    the requirement's (`requirements/agree.ts:acceptRevision`). Nullable: null reads as "names no
--    title of its own" and changes nothing on accept.
-- 2. Every existing revision is backfilled with its requirement's title. No route ever changed a
--    title before this, so that is the title each revision stood under. A blank title is left null.
-- 3. The revision guard freezes the title with the rest of the content once a revision leaves
--    draft. The backfill runs before the guard is replaced, since the guard in force does not yet
--    read the column.
--
-- ROLLBACK: put back 0493's requirement_revision_guard(), then DROP the check and the column. A
-- title a later revision gave stays on requirements.title, so nothing a person agreed is lost.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN IF NOT EXISTS "title" text;--> statement-breakpoint
UPDATE "requirement_revisions" AS rr SET "title" = r."title" FROM "requirements" AS r WHERE rr."requirement_id" = r."id" AND rr."title" IS NULL AND r."title" ~ '[^[:space:]]';--> statement-breakpoint
ALTER TABLE "requirement_revisions" DROP CONSTRAINT IF EXISTS "requirement_revisions_title_chk";--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_title_chk" CHECK ("requirement_revisions"."title" IS NULL OR "requirement_revisions"."title" ~ '[^[:space:]]');--> statement-breakpoint
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
    OR NEW."title" IS DISTINCT FROM OLD."title"
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
END $$;
