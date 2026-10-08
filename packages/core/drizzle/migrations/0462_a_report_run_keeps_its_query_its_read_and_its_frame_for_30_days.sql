-- A report run keeps its provenance and its frame for 30 days. `report_runs` holds each run of a
-- registered report query: the query and its version, the parsed params, the permission it declared,
-- who asked and as what, the moment it read, and the frame it answered. A visual block in a message
-- names its run, and its figures must be that frame's; a read past `expires_at` is refused by name,
-- and the nightly retention pass deletes the row.
--
-- ROLLBACK: DROP TABLE report_runs;
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"query_id" text NOT NULL,
	"query_version" integer NOT NULL,
	"params" jsonb NOT NULL,
	"permission" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"frame" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_runs_actor_chk" CHECK ("report_runs"."actor_kind" IN ('human', 'agent')),
	CONSTRAINT "report_runs_keep_chk" CHECK ("report_runs"."expires_at" > "report_runs"."as_of"),
	CONSTRAINT "report_runs_params_chk" CHECK (jsonb_typeof("report_runs"."params") = 'object'),
	CONSTRAINT "report_runs_frame_chk" CHECK (jsonb_typeof("report_runs"."frame") = 'object')
);
--> statement-breakpoint
ALTER TABLE "report_runs" DROP CONSTRAINT IF EXISTS "report_runs_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" DROP CONSTRAINT IF EXISTS "report_runs_actor_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_runs_expires_idx" ON "report_runs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_runs_project_as_of_idx" ON "report_runs" USING btree ("project_id","as_of");
