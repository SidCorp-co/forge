CREATE TABLE "master_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"master_session_id" uuid NOT NULL,
	"verb" text NOT NULL,
	"issue_key" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"dispatched" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parked" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	CONSTRAINT "master_passes_verb_chk" CHECK ("master_passes"."verb" IN ('triage', 'dispatch', 'fold', 'judge', 'release', 'park')),
	CONSTRAINT "master_passes_ended_after_start_chk" CHECK ("master_passes"."ended_at" IS NULL OR "master_passes"."ended_at" >= "master_passes"."started_at"),
	CONSTRAINT "master_passes_skipped_shape_chk" CHECK (jsonb_typeof("master_passes"."skipped") = 'array'),
	CONSTRAINT "master_passes_open_reports_nothing_chk" CHECK ("master_passes"."ended_at" IS NOT NULL OR (cardinality("master_passes"."dispatched") = 0 AND cardinality("master_passes"."parked") = 0 AND "master_passes"."skipped" = '[]'::jsonb))
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "max_job_panes" integer;--> statement-breakpoint
ALTER TABLE "master_passes" ADD CONSTRAINT "master_passes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_passes" ADD CONSTRAINT "master_passes_master_session_id_agent_sessions_id_fk" FOREIGN KEY ("master_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "master_passes_one_open_uq" ON "master_passes" USING btree ("master_session_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "master_passes_project_started_idx" ON "master_passes" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "master_passes_project_ended_idx" ON "master_passes" USING btree ("project_id","ended_at");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_max_job_panes_chk" CHECK ("devices"."max_job_panes" IS NULL OR "devices"."max_job_panes" BETWEEN 1 AND 64);--> statement-breakpoint
CREATE FUNCTION "master_pass_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "agent_sessions" WHERE "id" = OLD."master_session_id")
       OR NOT EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."project_id") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'MASTER_PASS_IMMUTABLE: pass % of master session % is never deleted; it goes with its session or project', OLD."id", OLD."master_session_id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."ended_at" IS NOT NULL THEN
    RAISE EXCEPTION 'MASTER_PASS_IMMUTABLE: pass % ended at %, and a closed pass is final', OLD."id", OLD."ended_at" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."master_session_id" IS DISTINCT FROM OLD."master_session_id"
     OR NEW."verb" IS DISTINCT FROM OLD."verb"
     OR NEW."issue_key" IS DISTINCT FROM OLD."issue_key"
     OR NEW."started_at" IS DISTINCT FROM OLD."started_at" THEN
    RAISE EXCEPTION 'MASTER_PASS_IMMUTABLE: open pass % changes only by closing it (ended_at, dispatched, skipped, parked)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "master_passes_guard" BEFORE UPDATE OR DELETE ON "master_passes" FOR EACH ROW EXECUTE FUNCTION "master_pass_guard"();