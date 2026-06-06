-- ISS-393 — remove the manual-hold / on_hold-as-block failure model.
--
-- A mechanically-failed job now reverts its issue to the stage entry-status
-- (retry) or parks it at `waiting` (budget exhausted / non-retryable); the
-- system no longer sets a manual-hold flag. `on_hold` is a deliberate user
-- pause only. The three columns backing the old model are dropped here AFTER
-- every reader (dispatcher L1 gate, pipeline-health, sweeper auto-clear,
-- admin /clear-hold, the MCP writable field, web UI) was removed in this same
-- change — so no runtime path reads a dropped column.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0084-0098 headers). The runtime migrator applies
-- this row from _journal.json.

ALTER TABLE "issues" DROP COLUMN IF EXISTS "manual_hold";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "manual_hold_until";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "failure_context";
