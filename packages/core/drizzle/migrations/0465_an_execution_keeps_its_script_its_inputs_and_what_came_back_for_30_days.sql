-- An execution keeps its script, its inputs and what came back for 30 days. `report_executions` holds
-- each run of a script by a sandbox executor (REQ-32 C1): the room or session that asked, the turn's
-- credential the per-turn caps are counted by, who asked and as what, the adapter, the script and the
-- sha256 of its normalized text, the report runs it read, the limits it ran under, its exit, the limit
-- that stopped it, its duration, and its frames and logs capped (the logs scrubbed). A visual block
-- drawn from it names it and is labelled computed; a read past `expires_at` is refused by name, and
-- the nightly retention pass deletes the row.
--
-- ROLLBACK: DROP TABLE report_executions;
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid,
	"turn_key" text NOT NULL,
	"asked_by" uuid NOT NULL,
	"asked_agency" text NOT NULL,
	"adapter" text NOT NULL,
	"adapter_execution_id" text,
	"language" text NOT NULL,
	"script" text NOT NULL,
	"script_fingerprint" text NOT NULL,
	"input_run_ids" uuid[] NOT NULL,
	"limits" jsonb NOT NULL,
	"exit" integer NOT NULL,
	"stopped" text,
	"duration_ms" real NOT NULL,
	"output_bytes" integer NOT NULL,
	"frames" jsonb NOT NULL,
	"logs" jsonb NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "report_executions_agency_chk" CHECK ("report_executions"."asked_agency" IN ('human', 'agent')),
	CONSTRAINT "report_executions_language_chk" CHECK ("report_executions"."language" IN ('python', 'bash')),
	CONSTRAINT "report_executions_stopped_chk" CHECK ("report_executions"."stopped" IS NULL OR "report_executions"."stopped" IN ('wallMs', 'cpu', 'memoryMb', 'outputBytes')),
	CONSTRAINT "report_executions_fingerprint_chk" CHECK ("report_executions"."script_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "report_executions_keep_chk" CHECK ("report_executions"."expires_at" > "report_executions"."created_at"),
	CONSTRAINT "report_executions_duration_chk" CHECK ("report_executions"."duration_ms" >= 0),
	CONSTRAINT "report_executions_output_chk" CHECK ("report_executions"."output_bytes" >= 0),
	CONSTRAINT "report_executions_limits_chk" CHECK (jsonb_typeof("report_executions"."limits") = 'object'),
	CONSTRAINT "report_executions_frames_chk" CHECK (jsonb_typeof("report_executions"."frames") = 'array'),
	CONSTRAINT "report_executions_logs_chk" CHECK (jsonb_typeof("report_executions"."logs") = 'object')
);
--> statement-breakpoint
ALTER TABLE "report_executions" DROP CONSTRAINT IF EXISTS "report_executions_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "report_executions" ADD CONSTRAINT "report_executions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_executions" DROP CONSTRAINT IF EXISTS "report_executions_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "report_executions" ADD CONSTRAINT "report_executions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_executions" DROP CONSTRAINT IF EXISTS "report_executions_asked_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "report_executions" ADD CONSTRAINT "report_executions_asked_by_users_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_executions_project_created_idx" ON "report_executions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_executions_expires_idx" ON "report_executions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_executions_turn_idx" ON "report_executions" USING btree ("turn_key","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_executions_fingerprint_idx" ON "report_executions" USING btree ("project_id","script_fingerprint");
