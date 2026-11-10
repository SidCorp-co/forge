-- A room's session holds one token across its turns (ISS-1202). A Rocket.Chat room's session acts
-- every turn under its own fenced agent account (`support/dispatch.ts:handTurn`), so revoking its
-- token at each turn's end bounded nothing; it only answered 401 to a resident pane that reconnected
-- between turns. Migration 0324's trigger revoked `turn:<session id>` whenever a session left
-- `running`; it now leaves that token alone while a support room holds the session and it is not
-- archived, and revokes it as before on every other stop and on a delete. A person's chat turn token
-- (ISS-17) is untouched: it is still revoked at its turn's end.
--
-- The token is revoked when the room session truly ends: the session is deleted (as before), a turn
-- of it ends once it is archived or once no room holds it, or its rooms let go of it while no turn
-- runs (the new trigger on `support_rooms`). A let-go during a turn waits for that turn's end, so no
-- token is revoked earlier than the 0324 trigger would have. The token keeps an expiry, re-minted
-- near it by core (`agent-sessions/session-credential.ts:fencedSessionCredential`).
--
-- A turn was its token (ISS-1029: an action's `turn_id` is the token's id, its span the token's
-- life). With one token across turns, a turn is a row of its own, `support_session_turns`, opened by
-- core at the hand-over and ended by this trigger in the same statement that once revoked the token.
-- The backfill keeps every turn an action already names readable under its old id: its token's id,
-- its token's creation, and its revocation, or the token's end where it was never revoked and its
-- session no longer runs. Nothing is deleted, and this migration revokes nothing.
--
-- ROLLBACK: restore 0324's function body, DROP TRIGGER trg_support_rooms_let_go_revokes_turn_token
-- ON support_rooms, DROP FUNCTION forge_room_let_go_revokes_turn_token(), DROP TABLE
-- support_session_turns (the turns opened since are lost; old actions resolve through their tokens).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_session_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "agent_sessions"("id") ON DELETE CASCADE,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  CONSTRAINT "support_session_turns_span_chk" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_session_turns_session_started_idx" ON "support_session_turns" USING btree ("session_id", "started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_session_turns_one_open_uq" ON "support_session_turns" USING btree ("session_id") WHERE ended_at IS NULL;--> statement-breakpoint
INSERT INTO "support_session_turns" ("id", "session_id", "started_at", "ended_at")
SELECT DISTINCT ON (pat.id)
       pat.id,
       s.id,
       pat.created_at,
       CASE
         WHEN pat.revoked_at IS NOT NULL THEN GREATEST(pat.revoked_at, pat.created_at)
         WHEN s.status IN ('queued', 'running') AND (pat.expires_at IS NULL OR pat.expires_at > now()) THEN NULL
         ELSE GREATEST(LEAST(now(), COALESCE(pat.expires_at, now())), pat.created_at)
       END
  FROM support_actions a
  JOIN personal_access_tokens pat ON pat.id = a.turn_id
  JOIN agent_sessions s ON s.id = a.session_id
 WHERE a.turn_id IS NOT NULL
   AND a.session_id IS NOT NULL
   AND pat.name = 'turn:' || s.id::text
 ORDER BY pat.id
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_session_stop_revokes_turn_token() RETURNS trigger AS $$
BEGIN
  -- the turn that ran ends here, whoever stopped it
  UPDATE support_session_turns
     SET ended_at = GREATEST(now(), started_at)
   WHERE session_id = OLD.id
     AND ended_at IS NULL;
  -- a room's session keeps its one token between turns while a room holds it, unarchived
  IF TG_OP = 'UPDATE'
     AND (NEW.metadata ->> 'archived') IS DISTINCT FROM 'true'
     AND EXISTS (SELECT 1 FROM support_rooms WHERE session_id = OLD.id) THEN
    RETURN NULL;
  END IF;
  UPDATE personal_access_tokens
     SET revoked_at = now()
   WHERE name = 'turn:' || OLD.id::text
     AND revoked_at IS NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_room_let_go_revokes_turn_token() RETURNS trigger AS $$
BEGIN
  IF OLD.session_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.session_id IS NOT DISTINCT FROM OLD.session_id THEN
    RETURN NULL;
  END IF;
  -- a channel agent's other groups still hold it
  IF EXISTS (SELECT 1 FROM support_rooms WHERE session_id = OLD.session_id) THEN
    RETURN NULL;
  END IF;
  -- a turn still running keeps its token to its end, where the session's own trigger revokes it
  IF EXISTS (
    SELECT 1 FROM agent_sessions
     WHERE id = OLD.session_id AND status IN ('queued', 'running')
  ) THEN
    RETURN NULL;
  END IF;
  UPDATE personal_access_tokens
     SET revoked_at = now()
   WHERE name = 'turn:' || OLD.session_id::text
     AND revoked_at IS NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_support_rooms_let_go_revokes_turn_token ON support_rooms;--> statement-breakpoint
CREATE TRIGGER trg_support_rooms_let_go_revokes_turn_token
  AFTER UPDATE OF session_id OR DELETE ON support_rooms
  FOR EACH ROW
  EXECUTE FUNCTION forge_room_let_go_revokes_turn_token();
