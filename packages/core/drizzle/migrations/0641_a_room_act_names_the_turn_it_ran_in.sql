-- ISS-1029. A room action names the session and the turn it was taken in: `session_id`, the
-- room's session, and `turn_id`, the credential core handed that one turn (minted at the hand-over,
-- revoked at its end), so the session's own record of the turn, what it read before it posted, is
-- found from the action. Rows written before this, and rows no turn wrote (a member's message, a
-- core note), hold neither. No row is rewritten.
--
-- ROLLBACK: drop the index and the two columns.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "support_actions" ADD COLUMN IF NOT EXISTS "session_id" uuid REFERENCES "agent_sessions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "support_actions" ADD COLUMN IF NOT EXISTS "turn_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_actions_session_turn_idx" ON "support_actions" ("session_id", "turn_id") WHERE "session_id" IS NOT NULL;
