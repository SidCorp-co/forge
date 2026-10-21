-- A mockup is proposed, tried and discussed on the item it shapes (REQ-49).
--   requirement_baseline_pins  the guard 0473 put on a mockup pin goes: an accepted mockup of a
--                              requirement is pinned by its next agree or re-pin beside the designs
--                              again (BC-6). Pins written before stay as they are.
--   mockups.revises_id, round  a returned mockup's next revision names it, and counts from 1; at most
--                              one next revision per mockup (BC-3). Both are fixed once written.
--   mockup_comments            a comment on one mockup, optionally pinned to a point or a region of
--                              its frame as fractions 0..1; settled once, as answered or resolved, by
--                              the next revision that names it (BC-2). Its text and pin never change.
--   feedback.mockup_id         a seventh member of the feedback target arc: an item about a mockup (BC-4).
--
-- ROLLBACK: DROP TABLE mockup_comments; ALTER TABLE feedback DROP COLUMN mockup_id and restore the
-- six-member feedback_arc_chk (0434); ALTER TABLE mockups DROP COLUMN revises_id, round; restore
-- mockup_guard from 0373; recreate the 0473 pin guard trigger. A feedback item about a mockup aborts
-- that rollback by name, as its arc would hold no target.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DROP TRIGGER IF EXISTS "requirement_baseline_pins_no_mockup" ON "requirement_baseline_pins";--> statement-breakpoint
DROP FUNCTION IF EXISTS "requirement_baseline_pin_guard"();--> statement-breakpoint
ALTER TABLE "mockups" ADD COLUMN IF NOT EXISTS "revises_id" uuid;--> statement-breakpoint
ALTER TABLE "mockups" ADD COLUMN IF NOT EXISTS "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mockups" DROP CONSTRAINT IF EXISTS "mockups_revises_id_mockups_id_fk";--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_revises_id_mockups_id_fk" FOREIGN KEY ("revises_id") REFERENCES "public"."mockups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockups" DROP CONSTRAINT IF EXISTS "mockups_round_chk";--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_round_chk" CHECK (("mockups"."revises_id" IS NULL AND "mockups"."round" = 1) OR ("mockups"."revises_id" IS NOT NULL AND "mockups"."round" >= 2));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mockups_revises_uq" ON "mockups" ("revises_id") WHERE "revises_id" IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "mockup_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."feedback_id" IS NOT NULL AND EXISTS (
         SELECT 1 FROM "feedback" WHERE "id" = OLD."feedback_id" AND "redacted_at" IS NOT NULL) THEN
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."project_id")
       AND (EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id")
         OR EXISTS (SELECT 1 FROM "feedback" WHERE "id" = OLD."feedback_id")
         OR EXISTS (SELECT 1 FROM "issues" WHERE "id" = OLD."issue_id")) THEN
      RAISE EXCEPTION 'MOCKUP_IMMUTABLE: mockup % is evidence and is never deleted; only deleting its target, or a reporter-data deletion of its feedback item, removes it', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."project_id" <> OLD."project_id" OR NEW."mockup_seq" <> OLD."mockup_seq"
     OR NEW."requirement_id" IS DISTINCT FROM OLD."requirement_id" OR NEW."revision" IS DISTINCT FROM OLD."revision"
     OR NEW."feedback_id" IS DISTINCT FROM OLD."feedback_id" OR NEW."issue_id" IS DISTINCT FROM OLD."issue_id"
     OR NEW."kind" <> OLD."kind" OR NEW."name" <> OLD."name" OR NEW."mime" <> OLD."mime" OR NEW."size" <> OLD."size"
     OR NEW."caption" IS DISTINCT FROM OLD."caption" OR NEW."storage_path" <> OLD."storage_path"
     OR NEW."proposed_by" <> OLD."proposed_by" OR NEW."proposed_agency" <> OLD."proposed_agency"
     OR NEW."revises_id" IS DISTINCT FROM OLD."revises_id" OR NEW."round" <> OLD."round" THEN
    RAISE EXCEPTION 'MOCKUP_IMMUTABLE: mockup % keeps what it holds and what it is about; propose a new one instead', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'proposed' THEN
    RAISE EXCEPTION 'MOCKUP_IMMUTABLE: mockup % is %, and a decided mockup stays decided', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mockup_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"mockup_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_agency" text NOT NULL,
	"body" text NOT NULL,
	"pin_x" double precision,
	"pin_y" double precision,
	"pin_w" double precision,
	"pin_h" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled" text,
	"settled_by_mockup_id" uuid,
	"settled_note" text,
	"settled_at" timestamp with time zone,
	CONSTRAINT "mockup_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "mockup_comments_mockup_id_mockups_id_fk" FOREIGN KEY ("mockup_id") REFERENCES "public"."mockups"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "mockup_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "mockup_comments_settled_by_mockup_id_mockups_id_fk" FOREIGN KEY ("settled_by_mockup_id") REFERENCES "public"."mockups"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "mockup_comments_agency_chk" CHECK ("mockup_comments"."author_agency" IN ('human', 'agent')),
	CONSTRAINT "mockup_comments_body_chk" CHECK ("mockup_comments"."body" ~ '[^[:space:]]'),
	CONSTRAINT "mockup_comments_pin_chk" CHECK ((num_nonnulls("mockup_comments"."pin_x", "mockup_comments"."pin_y", "mockup_comments"."pin_w", "mockup_comments"."pin_h") IN (0, 2, 4)) AND (("mockup_comments"."pin_x" IS NULL) = ("mockup_comments"."pin_y" IS NULL)) AND (("mockup_comments"."pin_w" IS NULL) = ("mockup_comments"."pin_h" IS NULL)) AND ("mockup_comments"."pin_x" IS NULL OR ("mockup_comments"."pin_x" BETWEEN 0 AND 1 AND "mockup_comments"."pin_y" BETWEEN 0 AND 1)) AND ("mockup_comments"."pin_w" IS NULL OR ("mockup_comments"."pin_w" > 0 AND "mockup_comments"."pin_h" > 0 AND "mockup_comments"."pin_x" + "mockup_comments"."pin_w" <= 1.000001 AND "mockup_comments"."pin_y" + "mockup_comments"."pin_h" <= 1.000001))),
	CONSTRAINT "mockup_comments_settled_chk" CHECK (("mockup_comments"."settled" IS NULL AND num_nonnulls("mockup_comments"."settled_by_mockup_id", "mockup_comments"."settled_note", "mockup_comments"."settled_at") = 0) OR ("mockup_comments"."settled" = 'answered' AND "mockup_comments"."settled_by_mockup_id" IS NOT NULL AND "mockup_comments"."settled_at" IS NOT NULL) OR ("mockup_comments"."settled" = 'resolved' AND "mockup_comments"."settled_by_mockup_id" IS NOT NULL AND "mockup_comments"."settled_at" IS NOT NULL AND "mockup_comments"."settled_note" ~ '[^[:space:]]'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mockup_comments_mockup_idx" ON "mockup_comments" ("mockup_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "mockup_comment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "mockups" WHERE "id" = OLD."mockup_id") THEN
      RAISE EXCEPTION 'MOCKUP_COMMENT_IMMUTABLE: comment % stays with its mockup; only removing the mockup removes it', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."project_id" <> OLD."project_id" OR NEW."mockup_id" <> OLD."mockup_id"
     OR NEW."author_id" <> OLD."author_id" OR NEW."author_agency" <> OLD."author_agency" OR NEW."body" <> OLD."body"
     OR NEW."pin_x" IS DISTINCT FROM OLD."pin_x" OR NEW."pin_y" IS DISTINCT FROM OLD."pin_y"
     OR NEW."pin_w" IS DISTINCT FROM OLD."pin_w" OR NEW."pin_h" IS DISTINCT FROM OLD."pin_h"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'MOCKUP_COMMENT_IMMUTABLE: comment % keeps what it says and where it points', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."settled" IS NOT NULL THEN
    RAISE EXCEPTION 'MOCKUP_COMMENT_IMMUTABLE: comment % is already %, and a settled comment stays settled', OLD."id", OLD."settled" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "mockup_comments_guard" ON "mockup_comments";--> statement-breakpoint
CREATE TRIGGER "mockup_comments_guard" BEFORE UPDATE OR DELETE ON "mockup_comments" FOR EACH ROW EXECUTE FUNCTION "mockup_comment_guard"();--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "mockup_id" uuid;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_mockup_id_mockups_id_fk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_mockup_id_mockups_id_fk" FOREIGN KEY ("mockup_id") REFERENCES "public"."mockups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_mockup_idx" ON "feedback" ("mockup_id") WHERE "mockup_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_arc_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_arc_chk" CHECK (num_nonnulls("feedback"."requirement_id", "feedback"."issue_id", "feedback"."release_run_id", "feedback"."workflow_id", "feedback"."contract_version", "feedback"."endpoint_element", "feedback"."mockup_id") = 1 OR (num_nonnulls("feedback"."requirement_id", "feedback"."issue_id", "feedback"."release_run_id", "feedback"."workflow_id", "feedback"."contract_version", "feedback"."endpoint_element", "feedback"."mockup_id") = 0 AND "feedback"."where_seen" IS NOT NULL));
