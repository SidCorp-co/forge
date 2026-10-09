-- A POC room (REQ-44 "POC rooms: build live with the owner, deliver only what is settled"): an idea
-- preview members join and chat in. `poc_rooms` binds the room to its preview and the preview's sketch
-- session; `state` is ROOM_MACHINE's and moves only through the kernel transition (0393's guard).
-- `poc_room_turns` keeps every ask with when its preview showed it and the commit that did,
-- `poc_room_items` what a person settled (a turn and its commit), `poc_room_members` who joined.
-- `previews.reason` takes SCHEMA_NEEDS_THROWAWAY_DATA: a room whose branch changed the schema while
-- its preview talks to the dev environment is stopped, naming the files (BC-12). Widening a CHECK
-- leaves every existing row valid.
--
-- ROLLBACK: DROP TABLE "poc_room_items", "poc_room_turns", "poc_room_members", "poc_rooms";
-- UPDATE no row (none can hold the new reason once its previews are deleted: DELETE FROM "previews"
-- WHERE "reason" = 'SCHEMA_NEEDS_THROWAWAY_DATA'), then rebuild previews_reason_chk without it.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "previews" DROP CONSTRAINT IF EXISTS "previews_reason_chk";--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_reason_chk" CHECK ("reason" IS NULL OR "reason" IN ('NO_START_COMMAND', 'PORT_UNDECLARED', 'PORT_IN_USE', 'DEV_SERVER_EXITED', 'DEV_SERVER_NOT_LISTENING', 'DEV_SERVER_EXPOSED', 'RUNNER_OFFLINE', 'RUNNER_CANNOT_PREVIEW', 'WORKTREE_GONE', 'PRODUCTION_ENVIRONMENT', 'REF_NOT_FOUND', 'SCHEMA_NEEDS_THROWAWAY_DATA'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poc_rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"preview_id" uuid NOT NULL REFERENCES "previews"("id") ON DELETE cascade,
	"session_id" uuid NOT NULL REFERENCES "agent_sessions"("id") ON DELETE cascade,
	"about_kind" text NOT NULL,
	"about_key" text NOT NULL,
	"branch" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"detail" text,
	"data" text NOT NULL,
	"settle" jsonb,
	"created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "poc_rooms_state_chk" CHECK ("state" IN ('open', 'settling', 'settled', 'abandoned')),
	CONSTRAINT "poc_rooms_about_chk" CHECK (("about_kind" = 'requirement' AND "about_key" ~ '^REQ-[0-9]{1,9}$') OR ("about_kind" = 'feedback' AND "about_key" ~ '^FB-[0-9]{1,9}$')),
	CONSTRAINT "poc_rooms_data_chk" CHECK ("data" IN ('demo', 'environment')),
	CONSTRAINT "poc_rooms_settle_chk" CHECK ("state" = 'open' OR "state" = 'abandoned' OR "settle" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poc_rooms_project_idx" ON "poc_rooms" ("project_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poc_rooms_session_uq" ON "poc_rooms" ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poc_rooms_preview_uq" ON "poc_rooms" ("preview_id");--> statement-breakpoint
SELECT forge_guard_status_column('poc_rooms'::regclass, 'state', 'room');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poc_room_members" (
	"room_id" uuid NOT NULL REFERENCES "poc_rooms"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poc_room_members_room_id_user_id_pk" PRIMARY KEY ("room_id", "user_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poc_room_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL REFERENCES "poc_rooms"("id") ON DELETE cascade,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"asked_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"ask" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reply" text,
	"shown_at" timestamp with time zone,
	"commit_sha" text,
	"files" jsonb,
	CONSTRAINT "poc_room_turns_kind_chk" CHECK ("kind" IN ('ask', 'trim')),
	CONSTRAINT "poc_room_turns_commit_chk" CHECK ("commit_sha" IS NULL OR "commit_sha" ~ '^[0-9a-f]{40}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poc_room_turns_seq_uq" ON "poc_room_turns" ("room_id", "seq");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poc_room_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL REFERENCES "poc_rooms"("id") ON DELETE cascade,
	"turn_id" uuid NOT NULL REFERENCES "poc_room_turns"("id") ON DELETE cascade,
	"commit_sha" text NOT NULL,
	"text" text NOT NULL,
	"settled_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poc_room_items_commit_chk" CHECK ("commit_sha" ~ '^[0-9a-f]{40}$')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poc_room_items_room_idx" ON "poc_room_items" ("room_id", "settled_at");
