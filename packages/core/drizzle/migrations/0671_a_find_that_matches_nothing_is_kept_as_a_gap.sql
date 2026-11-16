-- ISS-1256 (owner 2026-11-16). One search door over every record type: a find that matches nothing is
-- kept, so the gap it shows (a missing term, a missing rule) is readable, and opening a hit of any
-- type is a read the run-context record keeps, as it already keeps a knowledge or memory read.
--   1. find_misses, a new table, insert-only by use: one row per find that matched nothing.
--   2. run_context_reaches_kind_chk widens to every type the door opens: capability, requirement,
--      decision, reference, issue, feedback and conversation, beside the kinds it held.
-- No row of any existing table is changed.
--
-- ROLLBACK (no other table references find_misses; a widened kind must hold no row before narrowing):
--   DROP TABLE IF EXISTS find_misses;
--   ALTER TABLE "run_context_reaches" DROP CONSTRAINT "run_context_reaches_kind_chk",
--     ADD CONSTRAINT "run_context_reaches_kind_chk" CHECK ("kind" IN ('rule', 'knowledge', 'lesson', 'memory', 'agreement'));

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "find_misses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "query" text NOT NULL,
  "asked_by" text NOT NULL,
  "user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "find_misses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
  CONSTRAINT "find_misses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "find_misses_query_chk" CHECK (length("query") BETWEEN 1 AND 200),
  CONSTRAINT "find_misses_asked_by_chk" CHECK ("asked_by" IN ('person', 'agent'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "find_misses_project_idx" ON "find_misses" ("project_id", "created_at");--> statement-breakpoint
ALTER TABLE "run_context_reaches" DROP CONSTRAINT IF EXISTS "run_context_reaches_kind_chk";--> statement-breakpoint
ALTER TABLE "run_context_reaches" ADD CONSTRAINT "run_context_reaches_kind_chk" CHECK ("run_context_reaches"."kind" IN ('rule', 'knowledge', 'lesson', 'memory', 'agreement', 'capability', 'requirement', 'decision', 'reference', 'issue', 'feedback', 'conversation'));
