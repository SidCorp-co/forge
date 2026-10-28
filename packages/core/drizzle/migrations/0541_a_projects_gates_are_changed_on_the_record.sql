-- A project chooses how tightly Forge gates its agents (REQ-76): the profile and its overrides live in
-- the project document's `gates`, and every change to them is recorded here with who made it and why
-- (BC-12), Forge's own raise after a failed deploy or a rolled-back release included (BC-13).
--   project_gate_changes   one row per write of `gates`: the config revision it wrote, the profile
--                          and overrides before and after, the actor (person, agent, or forge with
--                          no account), the cause, the reason and the incident it names. Insert-only;
--                          a row goes only with its project.
-- No row is written here: rows are written by PUT /api/projects/:id/gates and by the raise.
--
-- ROLLBACK: DROP TABLE project_gate_changes; DROP FUNCTION project_gate_change_guard();

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_gate_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"config_revision" integer NOT NULL,
	"profile_from" text,
	"profile_to" text NOT NULL,
	"overrides_from" jsonb NOT NULL,
	"overrides_to" jsonb NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"cause" text NOT NULL,
	"reason" text NOT NULL,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_gate_changes_actor_chk" CHECK ("project_gate_changes"."actor_kind" IN ('person', 'agent', 'forge')),
	CONSTRAINT "project_gate_changes_cause_chk" CHECK ("project_gate_changes"."cause" IN ('set', 'deploy_failed', 'release_reverted')),
	CONSTRAINT "project_gate_changes_profile_to_chk" CHECK ("project_gate_changes"."profile_to" IN ('strict', 'standard', 'yolo')),
	CONSTRAINT "project_gate_changes_profile_from_chk" CHECK ("project_gate_changes"."profile_from" IS NULL OR "project_gate_changes"."profile_from" IN ('strict', 'standard', 'yolo')),
	CONSTRAINT "project_gate_changes_forge_actor_chk" CHECK (("project_gate_changes"."actor_kind" = 'forge') = ("project_gate_changes"."actor_user_id" IS NULL)),
	CONSTRAINT "project_gate_changes_reason_chk" CHECK (length(btrim("project_gate_changes"."reason")) > 0)
);--> statement-breakpoint
ALTER TABLE "project_gate_changes" DROP CONSTRAINT IF EXISTS "project_gate_changes_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "project_gate_changes" ADD CONSTRAINT "project_gate_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_gate_changes" DROP CONSTRAINT IF EXISTS "project_gate_changes_actor_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_gate_changes" ADD CONSTRAINT "project_gate_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_gate_changes_project_idx" ON "project_gate_changes" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_gate_change_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'project_gate_changes: % is insert-only; a change to a project''s gates is a new row', OLD.id;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS project_gate_changes_guard_trg ON "project_gate_changes";--> statement-breakpoint
CREATE TRIGGER project_gate_changes_guard_trg BEFORE UPDATE OR DELETE ON "project_gate_changes" FOR EACH ROW EXECUTE FUNCTION project_gate_change_guard();
--> statement-breakpoint
-- Forge itself writes a project document when it raises a yolo project's gates after an incident
-- (REQ-76 BC-13): that revision names no account, so `updated_by` is null for it and only for it.
-- ROLLBACK: UPDATE project_config_documents SET updated_by = <an admin> WHERE updated_by IS NULL;
-- ALTER TABLE project_config_documents ALTER COLUMN updated_by SET NOT NULL.
ALTER TABLE "project_config_documents" ALTER COLUMN "updated_by" DROP NOT NULL;
