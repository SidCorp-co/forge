-- ISS-1276 (ADR 0015): a Forge Box is a kernel record. `boxes` is BOX_MACHINE's table, its state
-- written only by the kernel transition; `box_acts` is every act on a box in order; `box_spans` a
-- criterion's span on the recording and the clip and still cut from it. The device reports its box
-- health on the heartbeat (`devices.box_health`), which core allocates from. `box.changed` is the
-- outbox event the Boxes page refetches on.
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "box_health" jsonb;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "box_health_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "boxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL REFERENCES "devices"("id") ON DELETE cascade,
	"project_id" uuid REFERENCES "projects"("id") ON DELETE cascade,
	"issue_id" uuid REFERENCES "issues"("id") ON DELETE cascade,
	"criterion" integer,
	"mode" text NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"opened_as" text DEFAULT 'agent' NOT NULL,
	"run_id" text,
	"held_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"held_since" timestamp with time zone,
	"last_input_at" timestamp with time zone,
	"queue" jsonb,
	"viewport" jsonb,
	"url" text,
	"view" jsonb,
	"recording_state" text,
	"recording_started_at" timestamp with time zone,
	"failure" text,
	"detail" text,
	"act_seq" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "boxes_mode_chk" CHECK ("mode" IN ('browser', 'android', 'desktop')),
	CONSTRAINT "boxes_state_chk" CHECK ("state" IN ('waiting', 'opening', 'warm', 'agent', 'person', 'closed', 'failed')),
	CONSTRAINT "boxes_held_chk" CHECK (("state" = 'person') = ("held_by" IS NOT NULL AND "held_since" IS NOT NULL)),
	CONSTRAINT "boxes_warm_chk" CHECK ("state" <> 'warm' OR ("project_id" IS NULL AND "issue_id" IS NULL)),
	CONSTRAINT "boxes_opened_as_chk" CHECK ("opened_as" IN ('agent', 'person')),
	CONSTRAINT "boxes_failed_chk" CHECK (("state" = 'failed') = ("failure" IS NOT NULL)),
	CONSTRAINT "boxes_recording_state_chk" CHECK ("recording_state" IS NULL OR "recording_state" IN ('recording', 'kept', 'dropped')),
	CONSTRAINT "boxes_failure_chk" CHECK ("failure" IS NULL OR "failure" IN ('START_FAILED', 'STREAM_LOST', 'BOX_GONE', 'DEVICE_OFFLINE'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boxes_device_state_idx" ON "boxes" ("device_id", "state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boxes_project_idx" ON "boxes" ("project_id", "asked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boxes_issue_idx" ON "boxes" ("issue_id");--> statement-breakpoint
SELECT forge_guard_status_column('boxes'::regclass, 'state', 'box');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "box_acts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"box_id" uuid NOT NULL REFERENCES "boxes"("id") ON DELETE cascade,
	"seq" integer NOT NULL,
	"by" text NOT NULL,
	"actor" text NOT NULL,
	"actor_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"kind" text NOT NULL,
	"command" jsonb NOT NULL,
	"state" text NOT NULL,
	"exit_code" integer,
	"stdout" text,
	"stderr" text,
	"duration_ms" integer,
	"refusal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "box_acts_by_chk" CHECK ("by" IN ('agent', 'person')),
	CONSTRAINT "box_acts_kind_chk" CHECK ("kind" IN ('read', 'write', 'input')),
	CONSTRAINT "box_acts_state_chk" CHECK ("state" IN ('pending', 'done', 'failed', 'refused'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "box_acts_seq_uq" ON "box_acts" ("box_id", "seq");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "box_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"box_id" uuid NOT NULL REFERENCES "boxes"("id") ON DELETE cascade,
	"issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
	"criterion" integer NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"start_offset_ms" integer,
	"end_offset_ms" integer,
	"clip_attachment_id" uuid REFERENCES "issue_attachments"("id") ON DELETE set null,
	"still_attachment_id" uuid REFERENCES "issue_attachments"("id") ON DELETE set null,
	"detail" text,
	"created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "box_spans_state_chk" CHECK ("state" IN ('open', 'cutting', 'attached', 'failed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "box_spans_box_idx" ON "box_spans" ("box_id", "criterion");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "box_spans_issue_idx" ON "box_spans" ("issue_id", "criterion");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "box_spans_one_open_uq" ON "box_spans" ("box_id", "criterion") WHERE state = 'open';
--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('box.changed') ON CONFLICT DO NOTHING;
