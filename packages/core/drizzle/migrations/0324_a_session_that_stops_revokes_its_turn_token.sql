-- A session's turn token (`turn:<session id>`, minted for the person the turn answers — ISS-17,
-- ISS-27) is revoked by the same statement that stops the session, whichever writer stops it: the
-- runner's terminal PATCH, a cancel, an abort to `idle`, a sweeper's reap, a delete. It was revoked
-- only by the two application paths that fire completion bridges, so a web-started session that was
-- cancelled or reaped kept a live token until it expired.
--
-- The trigger fires on every status that is not `queued` or `running` rather than on a list of
-- terminal ones, so a status added later revokes by default instead of leaving the token live.
-- The partial index serves its lookup by name; revoked rows fall out of it. Rollback is dropping
-- the two triggers, the function and the index.
CREATE INDEX "pat_live_name_idx" ON "personal_access_tokens" USING btree ("name") WHERE "personal_access_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_session_stop_revokes_turn_token() RETURNS trigger AS $$
BEGIN
  UPDATE personal_access_tokens
     SET revoked_at = now()
   WHERE name = 'turn:' || OLD.id::text
     AND revoked_at IS NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_agent_sessions_stop_revokes_turn_token ON agent_sessions;--> statement-breakpoint
CREATE TRIGGER trg_agent_sessions_stop_revokes_turn_token
  AFTER UPDATE OF status ON agent_sessions
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('queued', 'running'))
  EXECUTE FUNCTION forge_session_stop_revokes_turn_token();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_agent_sessions_delete_revokes_turn_token ON agent_sessions;--> statement-breakpoint
CREATE TRIGGER trg_agent_sessions_delete_revokes_turn_token
  AFTER DELETE ON agent_sessions
  FOR EACH ROW
  EXECUTE FUNCTION forge_session_stop_revokes_turn_token();
