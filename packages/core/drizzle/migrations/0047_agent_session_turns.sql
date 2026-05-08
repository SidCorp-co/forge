-- ISS-50 — agent_session_turns foundation. Sibling table that materializes
-- each entry of `agent_sessions.messages` jsonb into its own row so we can
-- address turns by id (edit/regenerate/permalink/fork). The jsonb blob stays
-- the source of truth during dual-write; a follow-up issue will deprecate it.

CREATE TABLE IF NOT EXISTS "agent_session_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_session_id" uuid NOT NULL REFERENCES "agent_sessions"("id") ON DELETE CASCADE,
  "turn_index" integer NOT NULL,
  "role" text NOT NULL,
  "content" jsonb NOT NULL,
  "parent_turn_id" uuid REFERENCES "agent_session_turns"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_session_turns_session_index_unique"
  ON "agent_session_turns" ("agent_session_id", "turn_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_session_turns_parent_idx"
  ON "agent_session_turns" ("parent_turn_id");
