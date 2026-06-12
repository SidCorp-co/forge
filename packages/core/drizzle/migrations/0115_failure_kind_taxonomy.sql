-- ISS-450 (ISS-442 C4 / invariant I4) — failure taxonomy rebuild.
-- Hand-written migration (applied from meta/_journal.json, follows the 0073 shape).
-- Replaces the v2 kind set (transient|permission|permanent|timeout|unknown) with
-- the v3 set (code|infra|transient-cc|timeout). Data remap runs FIRST, while the
-- old CHECK constraint (which permits the old values) is still in place; the
-- constraint swap then locks in the new set. Idempotent: the UPDATE's CASE only
-- touches old-value rows (a re-run matches zero), and the constraint swap is
-- DROP IF EXISTS + ADD.
--
-- NOTE: historical `transient` rows cannot be retro-split into `transient-cc`
-- (the cc-startup signal is not derivable from archived rows) — they collapse
-- to `infra`. Acceptable: both classes are bounded-retryable; only the failover
-- aggressiveness differs, and that only matters for live rows.
UPDATE "jobs" SET "failure_kind" = CASE "failure_kind"
  WHEN 'permanent' THEN 'code'
  WHEN 'permission' THEN 'infra'
  WHEN 'transient' THEN 'infra'
  WHEN 'unknown' THEN 'infra'
  ELSE "failure_kind"
END
WHERE "failure_kind" IN ('permanent', 'permission', 'transient', 'unknown');--> statement-breakpoint

ALTER TABLE "jobs"
  DROP CONSTRAINT IF EXISTS "jobs_failure_kind_check";--> statement-breakpoint

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_failure_kind_check"
  CHECK ("failure_kind" IS NULL OR "failure_kind" IN ('code','infra','transient-cc','timeout'));
