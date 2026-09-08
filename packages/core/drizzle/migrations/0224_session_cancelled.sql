-- ISS-964 criterion 17: a person stopping a session is not a reaper finding it
-- stale, and the record must be able to say which happened.
ALTER TABLE "agent_sessions"
  DROP CONSTRAINT IF EXISTS "agent_sessions_status_check";--> statement-breakpoint

ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_status_check"
  CHECK ("status" IN ('idle','queued','running','completed','failed','completed_via_recovery','cancelled_stale','cancelled'));
