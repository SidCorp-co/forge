-- A release pressed on a forge-beta twin project, taken by the `beta_port` fire and run on dev
-- (ISS-988, owner 2026-11-05: dev runs the release a beta user presses and writes the outcome
-- back). One row per beta release: the beta run's id is another instance's, so it is text and no
-- foreign key, and it is unique, so a beta release is taken once; the latest `beta_started_at` of a
-- beta project is the port's high-water mark there. No row exists before this migration.
--
-- ROLLBACK: DROP TABLE IF EXISTS "beta_port_releases"; the next fire takes every beta release still
-- running on beta again, and cuts a dev release for one already cut only where its dev issues are
-- back at the release gate, which the cut's own claim refuses while a release holds them.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "beta_port_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"beta_run_id" text NOT NULL,
	"beta_project_id" text NOT NULL,
	"beta_project_slug" text NOT NULL,
	"beta_version" text,
	"beta_started_at" timestamp with time zone NOT NULL,
	"beta_issues" jsonb NOT NULL,
	"dev_project_id" uuid NOT NULL,
	"dev_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_twin" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text NOT NULL,
	"said" text,
	"dev_run_id" uuid,
	"dev_version" text,
	"beta_ended" text,
	"told" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"written_back_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "beta_port_releases_state_chk" CHECK ("state" IN ('no_twin', 'waiting', 'requested', 'shipped', 'failed'))
);--> statement-breakpoint
ALTER TABLE "beta_port_releases" DROP CONSTRAINT IF EXISTS "beta_port_releases_dev_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "beta_port_releases" ADD CONSTRAINT "beta_port_releases_dev_project_id_projects_id_fk" FOREIGN KEY ("dev_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "beta_port_releases_beta_run_uq" ON "beta_port_releases" USING btree ("beta_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beta_port_releases_mark_idx" ON "beta_port_releases" USING btree ("beta_project_slug","beta_started_at");
