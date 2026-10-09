-- A release page opens on one to three highlights the assistant drafts from the requirements the
-- release completes or advances (REQ-40 BC-2; ISS-492), and a release page can be shared by Forge
-- link (BC-11). `release_highlights` holds one row per release run, written only by the
-- release-page drafter: pending, drafted with the digest of the facts it was drafted from, or failed
-- with the refusals the last draft earned. `share_links` takes the subject kind `release`. The
-- outbox takes `verdict.recorded`, which redrafts the highlights of every release carrying the issue
-- a commit verdict is recorded on.
--
-- ROLLBACK: DELETE FROM "share_links" WHERE "subject_kind" = 'release'; then restore the subject
-- CHECK without 'release'; DELETE FROM "pipeline_outbox" WHERE "type" = 'verdict.recorded';
-- DELETE FROM "outbox_event_types" WHERE "type" = 'verdict.recorded'; DROP TABLE
-- "release_highlights". Release pages then open on no highlights, and every shared release page
-- stops opening.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_highlights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"run_id" uuid NOT NULL REFERENCES "pipeline_runs"("id") ON DELETE cascade,
	"version" text NOT NULL,
	"state" text NOT NULL,
	"highlights" jsonb,
	"model" text,
	"source_digest" text,
	"drafted_at" timestamp with time zone,
	"refusals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_highlights_state_chk" CHECK ("state" IN ('drafted', 'none', 'pending', 'failed')),
	CONSTRAINT "release_highlights_drafted_chk" CHECK ("state" <> 'drafted' OR (jsonb_typeof("highlights") = 'array' AND "model" IS NOT NULL AND "source_digest" IS NOT NULL AND "drafted_at" IS NOT NULL)),
	CONSTRAINT "release_highlights_refusals_chk" CHECK (jsonb_typeof("refusals") = 'array')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_highlights_run_uq" ON "release_highlights" ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_highlights_project_idx" ON "release_highlights" ("project_id", "version");--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "share_links_subject_kind_chk";--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_subject_kind_chk" CHECK ("subject_kind" IN ('message', 'template-output', 'status-report', 'release'));--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('verdict.recorded') ON CONFLICT DO NOTHING;
