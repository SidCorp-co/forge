-- v1 EPIC 1 PR-C (ISS-295) — projects.api_key for widget auth
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "api_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_api_key_uq" ON "projects" USING btree ("api_key") WHERE "api_key" IS NOT NULL;--> statement-breakpoint
UPDATE "projects" SET "api_key" = 'fk_' || encode(gen_random_bytes(24), 'hex') WHERE "api_key" IS NULL;
