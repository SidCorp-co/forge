-- ISS-798 (stage ④) — Runner observation: device_skills gains observed_sha /
-- shadowed_by so the server can tell whether the pushed body is what actually
-- runs (not just that it was written to disk). jobs gains skills_ran_with so
-- each job carries the real skill hashes it executed with.
--
-- Minimum runner version for observation support: 0.7.0. Runners below that
-- floor never send these fields; the server treats null observed_sha as
-- `unknown` status (not `synced`), preventing the silent-shadow false-green
-- that motivated ISS-783.

ALTER TABLE "device_skills" ADD COLUMN "observed_sha" text;
--> statement-breakpoint
ALTER TABLE "device_skills" ADD COLUMN "shadowed_by" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "skills_ran_with" jsonb;
