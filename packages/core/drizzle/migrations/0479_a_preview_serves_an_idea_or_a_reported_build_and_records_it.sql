-- A preview serves something other than an issue's run (REQ-41 BC-14, BC-17; docs/proposals/chat-first.md):
-- an idea's sketch run (`session_id`, no issue) or a feedback item's past build (`feedback_id`, no
-- run), each with the `subject` it serves and the `checkout` its box cuts, both named by core. A
-- reproduce preview records what a member does in it (BC-18): `preview_recordings`, whose `state` is
-- RECORDING_MACHINE's and moves only through the kernel transition. A reporter's word on a fix
-- preview is `preview_fix_confirmations`, bound to the patch id served (BC-20). A box that cannot
-- fetch a reproduce's commit fails it REF_NOT_FOUND.
--
-- ROLLBACK: DROP TABLE "preview_fix_confirmations"; DROP TABLE "preview_recordings"; DELETE FROM
-- "previews" WHERE "subject_kind" <> 'issue'; then restore NOT NULL on issue_id and session_id, drop
-- the subject columns and their CHECKs, and rebuild previews_reason_chk without REF_NOT_FOUND.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "previews" ADD COLUMN IF NOT EXISTS "subject_kind" text DEFAULT 'issue' NOT NULL;--> statement-breakpoint
ALTER TABLE "previews" ADD COLUMN IF NOT EXISTS "subject" jsonb;--> statement-breakpoint
ALTER TABLE "previews" ADD COLUMN IF NOT EXISTS "checkout" jsonb;--> statement-breakpoint
ALTER TABLE "previews" ADD COLUMN IF NOT EXISTS "feedback_id" uuid REFERENCES "feedback"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "previews" ALTER COLUMN "issue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "previews" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "previews" DROP CONSTRAINT IF EXISTS "previews_subject_kind_chk";--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_subject_kind_chk" CHECK ("subject_kind" IN ('issue', 'idea', 'reproduce'));--> statement-breakpoint
ALTER TABLE "previews" DROP CONSTRAINT IF EXISTS "previews_subject_chk";--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_subject_chk" CHECK (
  ("subject_kind" = 'issue' AND "issue_id" IS NOT NULL AND "session_id" IS NOT NULL AND "subject" IS NULL AND "checkout" IS NULL AND "feedback_id" IS NULL)
  OR ("subject_kind" = 'idea' AND "issue_id" IS NULL AND "session_id" IS NOT NULL AND "subject" IS NOT NULL AND "checkout" IS NOT NULL)
  OR ("subject_kind" = 'reproduce' AND "issue_id" IS NULL AND "session_id" IS NULL AND "subject" IS NOT NULL AND "checkout" IS NOT NULL AND "feedback_id" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "previews" DROP CONSTRAINT IF EXISTS "previews_reason_chk";--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_reason_chk" CHECK ("reason" IS NULL OR "reason" IN ('NO_START_COMMAND', 'PORT_UNDECLARED', 'PORT_IN_USE', 'DEV_SERVER_EXITED', 'DEV_SERVER_NOT_LISTENING', 'DEV_SERVER_EXPOSED', 'RUNNER_OFFLINE', 'RUNNER_CANNOT_PREVIEW', 'WORKTREE_GONE', 'PRODUCTION_ENVIRONMENT', 'REF_NOT_FOUND'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "previews_feedback_idx" ON "previews" ("feedback_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "preview_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"feedback_id" uuid NOT NULL REFERENCES "feedback"("id") ON DELETE cascade,
	"preview_id" uuid NOT NULL REFERENCES "previews"("id") ON DELETE cascade,
	"build_sha" text NOT NULL,
	"build_release" text,
	"state" text DEFAULT 'recording' NOT NULL,
	"reason" text,
	"recorded_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"next_seq" integer DEFAULT 0 NOT NULL,
	"events" integer DEFAULT 0 NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"first_event_at" bigint,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_batch_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "preview_recordings_state_chk" CHECK ("state" IN ('recording', 'stopped', 'failed', 'expired', 'redacted')),
	CONSTRAINT "preview_recordings_reason_chk" CHECK ("reason" IS NULL OR "reason" IN ('RECORDER_BLOCKED', 'RECORDING_TOO_LARGE')),
	CONSTRAINT "preview_recordings_failed_reason_chk" CHECK (("state" = 'failed') = ("reason" IS NOT NULL)),
	CONSTRAINT "preview_recordings_sha_chk" CHECK ("build_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "preview_recordings_size_chk" CHECK ("events" >= 0 AND "bytes" BETWEEN 0 AND 52428800 AND "next_seq" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preview_recordings_one_open_uq" ON "preview_recordings" ("preview_id", "recorded_by") WHERE state = 'recording';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_recordings_feedback_idx" ON "preview_recordings" ("feedback_id", "started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_recordings_state_idx" ON "preview_recordings" ("state");--> statement-breakpoint
SELECT forge_guard_status_column('preview_recordings'::regclass, 'state', 'recording');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "preview_fix_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"feedback_id" uuid NOT NULL REFERENCES "feedback"("id") ON DELETE cascade,
	"preview_id" uuid NOT NULL REFERENCES "previews"("id") ON DELETE cascade,
	"patch_id" text NOT NULL,
	"verdict" text NOT NULL,
	"note" text,
	"by" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_fix_confirmations_verdict_chk" CHECK ("verdict" IN ('fixed', 'not_fixed')),
	CONSTRAINT "preview_fix_confirmations_patch_chk" CHECK ("patch_id" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "preview_fix_confirmations_note_chk" CHECK ("verdict" = 'fixed' OR ("note" IS NOT NULL AND length("note") > 0))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_fix_confirmations_feedback_idx" ON "preview_fix_confirmations" ("feedback_id", "at");
