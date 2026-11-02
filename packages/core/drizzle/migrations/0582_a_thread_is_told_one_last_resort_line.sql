-- A thread is told at most one last-resort line by core (ISS-875, owner 2026-11-02): core speaks on
-- its own only where the agent cannot (no box runs it, its turn failed, or the person is past the
-- room's message limit), and a row per thread, keyed by its adapter and that adapter's venue id for
-- the thread itself, written before the line is posted, keeps it to one across restarts and across
-- the doors into one thread. Every support thread already told one of the three (a posted `offline`
-- or `turn_failed`, or a `limit` line) is recorded as told, under its thread conversation's venue,
-- so the deploy does not tell it again. No existing row is rewritten.
--
-- ROLLBACK: DROP TABLE IF EXISTS "conversation_last_resorts";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_last_resorts" (
	"adapter" text NOT NULL,
	"venue" text NOT NULL,
	"kind" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_last_resorts_adapter_venue_pk" PRIMARY KEY("adapter","venue"),
	CONSTRAINT "conversation_last_resorts_kind_chk" CHECK ("conversation_last_resorts"."kind" IN ('offline', 'turn_failed', 'rate_limited'))
);--> statement-breakpoint
INSERT INTO "conversation_last_resorts" ("adapter", "venue", "kind", "posted_at")
SELECT DISTINCT ON (c."adapter", c."external_id")
	c."adapter",
	c."external_id",
	CASE a."tool" WHEN 'limit' THEN 'rate_limited' ELSE a."tool" END,
	a."created_at"
FROM "support_actions" a
JOIN "conversations" c ON c."id" = a."conversation_id"
WHERE a."kind" = 'refused'
	AND (a."tool" = 'limit' OR (a."tool" IN ('offline', 'turn_failed') AND a."output" ->> 'posted' = 'true'))
ORDER BY c."adapter", c."external_id", a."created_at"
ON CONFLICT DO NOTHING;
