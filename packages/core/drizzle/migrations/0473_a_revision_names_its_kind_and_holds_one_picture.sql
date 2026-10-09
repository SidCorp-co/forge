-- A requirement revision names its kind and holds one picture (REQ-35; Requirement lifecycle r14
-- steps picture, picture_none, picture_shown and agreed; Requirement to delivery r15 pins).
--
-- requirement_revisions: `kind` (process, rule, screen or report; null while none is named) and
-- `picture_id`, the picture it shows. Neither is frozen with the revision's text: the author
-- corrects the kind and anyone who may edit the requirement replaces the picture, and nothing gates
-- on either. Every revision written before this has no kind and no picture; nothing is backfilled,
-- because no kind was ever named (an accepted requirement mockup is not converted: its bytes live
-- in the attachment store, and its requirement has no kind to fit it to).
-- requirement_pictures: every picture written, insert-only; a replaced one stays as the history.
-- requirement_baseline_pins: a new pin naming a mockup is refused. Pins written before REQ-35 stay
-- as what those baselines agreed.
--
-- ROLLBACK: drop the pin guard trigger and its function, drop requirement_revisions.picture_id and
-- kind with its constraint, then drop requirement_pictures with its guard; every picture and kind
-- written is then gone, and baselines may pin a mockup again only once the code that wrote those
-- pins is restored.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint
ALTER TABLE "requirement_revisions" DROP CONSTRAINT IF EXISTS "requirement_revisions_kind_chk";--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_kind_chk" CHECK ("requirement_revisions"."kind" IS NULL OR "requirement_revisions"."kind" IN ('process', 'rule', 'screen', 'report'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requirement_pictures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requirement_id" uuid NOT NULL,
  "drawn_for" integer NOT NULL,
  "kind" text NOT NULL,
  "content" jsonb NOT NULL,
  "alt" text NOT NULL,
  "written_by" uuid NOT NULL,
  "written_agency" text NOT NULL,
  "written_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "requirement_pictures_revision_fk" FOREIGN KEY ("requirement_id", "drawn_for") REFERENCES "requirement_revisions"("requirement_id", "revision") ON DELETE cascade,
  CONSTRAINT "requirement_pictures_written_by_users_id_fk" FOREIGN KEY ("written_by") REFERENCES "users"("id") ON DELETE restrict,
  CONSTRAINT "requirement_pictures_kind_chk" CHECK ("requirement_pictures"."kind" IN ('flow', 'example_table', 'wireframe', 'chart')),
  CONSTRAINT "requirement_pictures_alt_chk" CHECK ("requirement_pictures"."alt" ~ '[^[:space:]]'),
  CONSTRAINT "requirement_pictures_agency_chk" CHECK ("requirement_pictures"."written_agency" IN ('human', 'agent'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requirement_pictures_requirement_idx" ON "requirement_pictures" ("requirement_id","written_at");--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN IF NOT EXISTS "picture_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement_revisions" DROP CONSTRAINT IF EXISTS "requirement_revisions_picture_id_requirement_pictures_id_fk";--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_picture_id_requirement_pictures_id_fk" FOREIGN KEY ("picture_id") REFERENCES "requirement_pictures"("id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "requirement_picture_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'REQUIREMENT_PICTURE_IMMUTABLE: a picture of requirement % is insert-only; replacing it writes a new row and the earlier stays as history', OLD."requirement_id" USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "requirement_pictures_guard" ON "requirement_pictures";--> statement-breakpoint
CREATE TRIGGER "requirement_pictures_guard" BEFORE UPDATE OR DELETE ON "requirement_pictures" FOR EACH ROW EXECUTE FUNCTION "requirement_picture_guard"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "requirement_baseline_pin_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mockup_id" IS NOT NULL THEN
    RAISE EXCEPTION 'REQUIREMENT_PIN_MOCKUP: requirement % revision % baseline % pins mockup %; no baseline pins a mockup or a picture (Requirement lifecycle r14 agreed)', NEW."requirement_id", NEW."revision", NEW."baseline_seq", NEW."mockup_id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "requirement_baseline_pins_no_mockup" ON "requirement_baseline_pins";--> statement-breakpoint
CREATE TRIGGER "requirement_baseline_pins_no_mockup" BEFORE INSERT ON "requirement_baseline_pins" FOR EACH ROW EXECUTE FUNCTION "requirement_baseline_pin_guard"();
