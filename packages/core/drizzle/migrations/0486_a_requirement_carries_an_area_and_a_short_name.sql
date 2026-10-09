-- REQ-29 "Requirements carry an area the list groups and filters by": `requirement_areas` is a
-- project's list of business areas; a requirement gets a nullable `area_id` and `short_name`, and the
-- assistant's proposal waits in `proposed_area_id` / `proposed_short_name` until a person accepts it.
-- Every column is nullable and no row is backfilled: an existing requirement has no area until a
-- person sets or accepts one.
--
-- ROLLBACK: ALTER TABLE "requirements" DROP COLUMN "area_id", DROP COLUMN "short_name",
-- DROP COLUMN "proposed_area_id", DROP COLUMN "proposed_short_name"; DROP TABLE "requirement_areas";
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requirement_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_areas_name_chk" CHECK (length("name") BETWEEN 1 AND 60)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "requirement_areas_project_name_uq" ON "requirement_areas" ("project_id", "name");--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "area_id" uuid REFERENCES "requirement_areas"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "short_name" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "proposed_area_id" uuid REFERENCES "requirement_areas"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "proposed_short_name" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_short_name_chk" CHECK (("short_name" IS NULL OR length("short_name") BETWEEN 1 AND 80) AND ("proposed_short_name" IS NULL OR length("proposed_short_name") BETWEEN 1 AND 80));
