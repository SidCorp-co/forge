-- ISS-74 — drop write-only chat_sessions columns. Verified via repo-wide grep:
-- no code path reads `summary`, `summarized_at`, `metadata`, or `widget_user_id`.
--
-- ⚠️  DESTRUCTIVE — irreversible without pg_restore. Before applying to prod:
--   SELECT count(*) FROM chat_sessions
--    WHERE summary IS NOT NULL
--       OR summarized_at IS NOT NULL
--       OR metadata IS NOT NULL
--       OR widget_user_id IS NOT NULL;
-- If non-zero, snapshot the affected rows first:
--   CREATE TABLE chat_sessions_pre_0052 AS
--   SELECT id, summary, summarized_at, metadata, widget_user_id
--     FROM chat_sessions
--    WHERE summary IS NOT NULL OR summarized_at IS NOT NULL
--       OR metadata IS NOT NULL OR widget_user_id IS NOT NULL;
-- Otherwise the data is gone post-migration; rollback = pg_restore from backup.
ALTER TABLE "chat_sessions" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "summarized_at";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "widget_user_id";
