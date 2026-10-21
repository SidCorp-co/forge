-- A steward note says where a requirement or a feedback item stands, in two lines (REQ-48 BC-7, BC-8).
--   steward_notes   line 1: what happened and what blocks; line 2: what is next and by when, with the
--                   records it cites, the claims it makes about the standing and the standing's basis
--                   it was vetted against. Insert-only: a write supersedes the current row in the same
--                   transaction, so superseded_at is the one column that changes, once; a row goes only
--                   with its project. One current note per subject (steward_notes_current_uq).
-- No row is written here: notes are written by the steward and by people through
-- PUT /api/projects/:id/steward-notes/:subjectKind/:key.
--
-- ROLLBACK: DROP TABLE steward_notes; DROP FUNCTION steward_note_guard();

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "steward_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"lines" text[] NOT NULL,
	"cites" jsonb NOT NULL,
	"claims" jsonb NOT NULL,
	"basis" text NOT NULL,
	"written_by" uuid NOT NULL,
	"run_id" uuid,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "steward_notes_subject_kind_chk" CHECK ("steward_notes"."subject_kind" IN ('requirement', 'feedback')),
	CONSTRAINT "steward_notes_lines_chk" CHECK (cardinality("steward_notes"."lines") BETWEEN 1 AND 2)
);--> statement-breakpoint
ALTER TABLE "steward_notes" DROP CONSTRAINT IF EXISTS "steward_notes_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "steward_notes" ADD CONSTRAINT "steward_notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_notes" DROP CONSTRAINT IF EXISTS "steward_notes_written_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "steward_notes" ADD CONSTRAINT "steward_notes_written_by_users_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "steward_notes_current_uq" ON "steward_notes" USING btree ("subject_kind","subject_id") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steward_notes_project_idx" ON "steward_notes" USING btree ("project_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION steward_note_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (to_jsonb(NEW) - 'superseded_at') <> (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'steward_notes: % is insert-only; a write supersedes it once and changes nothing else', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS steward_notes_guard_trg ON "steward_notes";--> statement-breakpoint
CREATE TRIGGER steward_notes_guard_trg BEFORE UPDATE OR DELETE ON "steward_notes" FOR EACH ROW EXECUTE FUNCTION steward_note_guard();
