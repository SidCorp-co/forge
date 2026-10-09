-- A run's dev server is served to the project's members from a Forge link while the change is made
-- (REQ-39 BC-1, BC-9; docs/proposals/live-preview.md; ISS-491). One row per preview: the issue and
-- session whose worktree it serves, the box holding that worktree, the host label (`slug`) under
-- PREVIEW_DOMAIN, the command and port it runs on, and, once approved, the patch id and files of
-- what the approver saw and the lane they classify to. `state` is PREVIEW_MACHINE's and moves only
-- through the kernel transition (0393's guard); a session holds one open preview at a time. A
-- preview's moves are `preview.transitioned` outbox events, told to the project room.
--
-- ROLLBACK: DROP TABLE "previews"; DELETE FROM "outbox_event_types" WHERE "type" = 'preview.transitioned'
-- once no outbox row holds it; previews and their links are then gone, and nothing else reads them.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
	"session_id" uuid NOT NULL REFERENCES "agent_sessions"("id") ON DELETE cascade,
	"device_id" uuid NOT NULL REFERENCES "devices"("id") ON DELETE cascade,
	"slug" text NOT NULL,
	"state" text DEFAULT 'starting' NOT NULL,
	"reason" text,
	"detail" text,
	"command" text NOT NULL,
	"port" integer,
	"idle_minutes" integer NOT NULL,
	"approved_patch_id" text,
	"approved_files" jsonb,
	"lane_decision" jsonb,
	"approved_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"live_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "previews_state_chk" CHECK ("state" IN ('starting', 'live', 'idle_closed', 'approved', 'abandoned', 'failed')),
	CONSTRAINT "previews_reason_chk" CHECK ("reason" IS NULL OR "reason" IN ('NO_START_COMMAND', 'PORT_UNDECLARED', 'PORT_IN_USE', 'DEV_SERVER_EXITED', 'DEV_SERVER_NOT_LISTENING', 'DEV_SERVER_EXPOSED', 'RUNNER_OFFLINE', 'RUNNER_CANNOT_PREVIEW', 'WORKTREE_GONE', 'PRODUCTION_ENVIRONMENT')),
	CONSTRAINT "previews_failed_reason_chk" CHECK (("state" = 'failed') = ("reason" IS NOT NULL)),
	CONSTRAINT "previews_slug_chk" CHECK ("slug" ~ '^p-[a-z2-7]{16}$'),
	CONSTRAINT "previews_port_chk" CHECK ("port" IS NULL OR "port" BETWEEN 1024 AND 65535),
	CONSTRAINT "previews_idle_chk" CHECK ("idle_minutes" BETWEEN 5 AND 240),
	CONSTRAINT "previews_patch_chk" CHECK ("approved_patch_id" IS NULL OR "approved_patch_id" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "previews_approved_chk" CHECK (("state" = 'approved') = ("approved_patch_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "previews_slug_uq" ON "previews" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "previews_one_open_per_session_uq" ON "previews" ("session_id") WHERE state IN ('starting', 'live', 'idle_closed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "previews_issue_idx" ON "previews" ("issue_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "previews_device_idx" ON "previews" ("device_id");--> statement-breakpoint
SELECT forge_guard_status_column('previews'::regclass, 'state', 'preview');--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('preview.transitioned') ON CONFLICT DO NOTHING;
