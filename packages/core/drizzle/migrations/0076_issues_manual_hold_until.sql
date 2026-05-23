-- ISS-198 — manual hold lifecycle.
--
-- Adds an expiry column for the manual_hold flag. Semantics:
--   * NULL  → indefinite hold; only an operator can clear it. Used for
--             permanent / permission failures (403, invalid config, etc.).
--   * value → auto-clear horizon; the pipeline sweeper drops the hold once
--             now() crosses the timestamp, provided no fresh failure landed
--             in the last 5 minutes (anti-ping-pong).
--
-- Backfill: NULL for existing rows. Pre-existing holds therefore remain
-- "operator-clear only" until they're re-set by a fresh failure path —
-- safe by default for self-hosted deployments that upgrade with stuck
-- holds in flight.
ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "manual_hold_until" timestamptz;

COMMENT ON COLUMN "issues"."manual_hold_until" IS
  'When manual_hold=true: NULL = indefinite hold (permission/permanent), timestamp = auto-clear after this point.';

-- Partial index — the sweeper scans `manual_hold = true AND manual_hold_until
-- IS NOT NULL AND manual_hold_until < now()`. Restricting the index to that
-- subset keeps it tiny regardless of overall issue volume.
CREATE INDEX IF NOT EXISTS "idx_issues_manual_hold_until"
  ON "issues" ("manual_hold_until")
  WHERE "manual_hold" = true AND "manual_hold_until" IS NOT NULL;
