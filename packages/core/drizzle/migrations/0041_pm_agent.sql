-- ISS-17 (PM Agent v1 EPIC 1) — schema + migration foundations.
-- Adds 4 tables for the stateless PM coordinator agent and a partial unique
-- index on `jobs` enforcing one active PM session per project. Foundation only,
-- no behaviour change. Subsequent epics light up the tables.
--
-- Enum extensions for `memories.source` (+ decision, policy), `notifications.type`
-- (+ pm_escalation), and `jobs.type` (+ pm) are TS-only — these columns are
-- declared as plain `text NOT NULL` without DB-level CHECK constraints
-- (verified across migrations 0003 / 0010 / 0020 / 0023). Drizzle's
-- `text(col, { enum: [...] })` wraps types only; the array additions in
-- `schema.ts` are sufficient. No ALTER TABLE statements needed here.

CREATE TABLE IF NOT EXISTS "issue_dependencies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "from_issue_id" uuid NOT NULL,
  "to_issue_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "reason" text,
  "created_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "valid_until" timestamp with time zone,
  CONSTRAINT "issue_dependencies_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
  CONSTRAINT "issue_dependencies_from_issue_id_fkey"
    FOREIGN KEY ("from_issue_id") REFERENCES "issues"("id") ON DELETE CASCADE,
  CONSTRAINT "issue_dependencies_to_issue_id_fkey"
    FOREIGN KEY ("to_issue_id") REFERENCES "issues"("id") ON DELETE CASCADE,
  CONSTRAINT "issue_dependencies_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "issue_dependencies_unique_edge_idx"
  ON "issue_dependencies" ("project_id", "from_issue_id", "to_issue_id", "kind");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "issue_dependencies_project_from_idx"
  ON "issue_dependencies" ("project_id", "from_issue_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "issue_dependencies_project_to_idx"
  ON "issue_dependencies" ("project_id", "to_issue_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pm_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "session_id" uuid,
  "cause" text NOT NULL,
  "event_ref" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "summary" text NOT NULL,
  "actions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "confidence" real,
  "model_tier" text,
  "took_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_decisions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pm_decisions_project_created_idx"
  ON "pm_decisions" ("project_id", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pm_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL UNIQUE,
  "enabled" boolean NOT NULL DEFAULT false,
  "cadence_cron" text,
  "event_triggers" jsonb NOT NULL DEFAULT
    '{"jobFailed":true,"pipelineStalled":true,"needsInfo":true,"queuePressure":true,"graphChanged":true}'::jsonb,
  "custom_instructions" text,
  "model_override" text,
  "max_runs_per_hour" integer NOT NULL DEFAULT 6,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_config_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pm_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "body" text NOT NULL,
  "embedding" vector(1536),
  "enabled" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_policies_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pm_policies_project_enabled_priority_idx"
  ON "pm_policies" ("project_id", "enabled", "priority" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pm_policies_embedding_hnsw_idx"
  ON "pm_policies" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint

-- Enforce at most one active PM job per project. PM jobs have NULL issue_id, so
-- the existing `jobs_active_unique` (keyed on issue_id, type) does not cover
-- them. This is a sibling partial unique index keyed on project_id alone for
-- type='pm' rows in active states.
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_pm_per_project_unique_idx"
  ON "jobs" ("project_id")
  WHERE "type" = 'pm' AND "status" IN ('queued','dispatched','running');
