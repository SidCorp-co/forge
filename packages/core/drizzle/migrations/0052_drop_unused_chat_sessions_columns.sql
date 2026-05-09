-- ISS-74 — drop write-only chat_sessions columns. Verified via repo-wide grep:
-- no code path reads `summary`, `summarized_at`, `metadata`, or `widget_user_id`.
ALTER TABLE "chat_sessions" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "summarized_at";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "widget_user_id";
