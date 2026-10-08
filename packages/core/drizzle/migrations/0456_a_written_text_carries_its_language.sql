-- Text a person or a model writes carries the language it was written in: an issue's title and body,
-- a feedback item and its messages, a comment, a requirement revision and a harness report. A reader
-- whose interface language differs sees the text as written, marked with its language, and never a
-- silent machine translation. Found by measuring forge-dev's hop project in vi on 2026-10-08: 33 of
-- the 41 English lines on its pages were text written in English into a vi project (harness reports,
-- issue titles, a feedback body), shown with nothing saying it was written in another language.
--
-- An integration connection's health detail is a sentence core composes from what the probe found;
-- `last_health_says` keeps the registry sentence (`@forge/contracts/said`) it was rendered from, so the
-- integrations card reads it in the reader's language.
--
-- Additive: nullable columns and checks only. NO BACKFILL, deliberately: a row written before this
-- holds no record of its writer's language, and a language guessed from the project or the text would
-- be stated as fact. Null reads as "written before the language was stored" and shows with no mark.
--
-- ROLLBACK: for t in issues, feedback, feedback_messages, comments, requirement_revisions, agent_reports:
--             ALTER TABLE <t> DROP CONSTRAINT IF EXISTS <t>_written_lang_chk;
--             ALTER TABLE <t> DROP COLUMN IF EXISTS written_lang;
--           ALTER TABLE integration_connections DROP COLUMN IF EXISTS last_health_says;

ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "written_lang" text;--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_written_lang_chk";--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_written_lang_chk" CHECK ("issues"."written_lang" IS NULL OR "issues"."written_lang" IN ('en', 'vi'));--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "written_lang" text;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_written_lang_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_written_lang_chk" CHECK ("feedback"."written_lang" IS NULL OR "feedback"."written_lang" IN ('en', 'vi'));--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD COLUMN IF NOT EXISTS "written_lang" text;--> statement-breakpoint
ALTER TABLE "feedback_messages" DROP CONSTRAINT IF EXISTS "feedback_messages_written_lang_chk";--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_written_lang_chk" CHECK ("feedback_messages"."written_lang" IS NULL OR "feedback_messages"."written_lang" IN ('en', 'vi'));--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "written_lang" text;--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "comments_written_lang_chk";--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_written_lang_chk" CHECK ("comments"."written_lang" IS NULL OR "comments"."written_lang" IN ('en', 'vi'));--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN IF NOT EXISTS "written_lang" text;--> statement-breakpoint
ALTER TABLE "requirement_revisions" DROP CONSTRAINT IF EXISTS "requirement_revisions_written_lang_chk";--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_written_lang_chk" CHECK ("requirement_revisions"."written_lang" IS NULL OR "requirement_revisions"."written_lang" IN ('en', 'vi'));--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN IF NOT EXISTS "written_lang" text;--> statement-breakpoint
ALTER TABLE "agent_reports" DROP CONSTRAINT IF EXISTS "agent_reports_written_lang_chk";--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_written_lang_chk" CHECK ("agent_reports"."written_lang" IS NULL OR "agent_reports"."written_lang" IN ('en', 'vi'));--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN IF NOT EXISTS "last_health_says" jsonb;
