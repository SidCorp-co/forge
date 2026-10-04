ALTER TABLE "project_members" ADD COLUMN "grants" text[] DEFAULT ARRAY[]::text[] NOT NULL;
