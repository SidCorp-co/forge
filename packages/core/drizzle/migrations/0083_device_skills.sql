-- Skill Studio 4 (ISS-278) — per (device × project × skill) install tracking.
--
-- The new Rust runner seeds `.claude/skills/<name>/` onto the device from the
-- server (pull-by-hash) and reports back the `installed_hash` it installed.
-- This table is the only place that tracks which device holds which skill
-- version, so the server can compute synced/outdated/missing without trusting
-- the device's filesystem.
--
-- `installed_hash` is the server-computed effective hash
-- (`hashSkillBody(effectiveMd, files)`) the runner echoed back — the runner
-- never recomputes the hash itself, which avoids any TS↔Rust hashing drift.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0080/0081/0082 headers). The runtime migrator
-- applies this row from _journal.json.

CREATE TABLE IF NOT EXISTS "device_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"installed_hash" text NOT NULL,
	"installed_version" integer,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_skills" ADD CONSTRAINT "device_skills_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_skills" ADD CONSTRAINT "device_skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_skills" ADD CONSTRAINT "device_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_skills_device_project_skill_uq" ON "device_skills" ("device_id","project_id","skill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_skills_device_project_idx" ON "device_skills" ("device_id","project_id");
