-- Every release cut is named (REQ-40 BC-14): where nobody named a release when it was drafted or
-- cut, the assistant drafts its name and summary from what it carries, and a draft it cannot write
-- is kept with why, so the release's page says it instead of opening on a bare version. One row per
-- project and version while that draft is owed or refused; the row goes once the release is named,
-- since the name itself lives where it always did (`release_draft_namings`, then the run's
-- `metadata.naming`). The outbox takes `release.cut`, which the cut emits in its own transaction so
-- the draft is owed even when nobody opens the page.
--
-- ROLLBACK: DELETE FROM "pipeline_outbox" WHERE "type" = 'release.cut'; DELETE FROM
-- "outbox_event_types" WHERE "type" = 'release.cut'; DROP TABLE "release_naming_drafts". A release
-- nobody names then opens on its version alone, and the master is owed its name as before.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_naming_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"version" text NOT NULL,
	"state" text NOT NULL,
	"model" text,
	"refusals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_naming_drafts_state_chk" CHECK ("state" IN ('drafting', 'failed')),
	CONSTRAINT "release_naming_drafts_refusals_chk" CHECK (jsonb_typeof("refusals") = 'array'),
	CONSTRAINT "release_naming_drafts_failed_chk" CHECK ("state" <> 'failed' OR jsonb_array_length("refusals") > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_naming_drafts_project_version_uq" ON "release_naming_drafts" ("project_id", "version");--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('release.cut') ON CONFLICT DO NOTHING;
