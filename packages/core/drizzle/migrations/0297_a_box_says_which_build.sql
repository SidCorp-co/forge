-- The commit a box's last heartbeat reported it was built from.
--
-- A version number alone cannot tell a released 0.17.0 from a hand-built one, and
-- that is how seven landed runner commits reached no box while every surface read
-- healthy (ISS-1165). Nullable on purpose: every binary built before the release
-- that carries the stamp reports no commit, and that is a build state of its own
-- rather than a value to invent.
ALTER TABLE "devices" ADD COLUMN "agent_commit" text;
