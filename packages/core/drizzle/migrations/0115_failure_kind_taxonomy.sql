-- ISS-450 (ISS-442 C4) — reshape jobs.failure_kind to the Decision C taxonomy:
--   code | infra | transient-cc | timeout   (drops transient|permission|permanent|unknown)
--
-- `failure_kind` is a TEXT column guarded by the CHECK constraint
-- `jobs_failure_kind_check` (last set in 0073_failure_recovery_rebuild.sql) —
-- it is NOT a pg enum, so this is a data-remap + constraint swap, not an enum
-- ALTER. Order matters: remap existing rows FIRST (the old constraint still
-- permits the legacy values), THEN drop + re-add the constraint with the four
-- new values.
--
-- Decision C remap:
--   permanent  -> code     (non-retryable defect)
--   permission -> infra    (retryable environmental/auth blip)
--   transient  -> infra    (retryable; historical rows CANNOT be retro-split
--                           into the new transient-cc class — that signal is
--                           not derivable after the fact — so they collapse to
--                           infra. Accepted + documented.)
--   unknown    -> infra    (retryable catch-all)
--   timeout    -> timeout  (unchanged)
--
-- Idempotent: the UPDATE matches zero legacy rows once remapped, and the
-- constraint swap uses IF EXISTS. Hand-written; the runtime migrator applies
-- this from _journal.json.

UPDATE "jobs"
   SET "failure_kind" = CASE "failure_kind"
     WHEN 'permanent'  THEN 'code'
     WHEN 'permission' THEN 'infra'
     WHEN 'transient'  THEN 'infra'
     WHEN 'unknown'    THEN 'infra'
     WHEN 'timeout'    THEN 'timeout'
     ELSE "failure_kind"
   END
 WHERE "failure_kind" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "jobs"
  DROP CONSTRAINT IF EXISTS "jobs_failure_kind_check";--> statement-breakpoint

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_failure_kind_check"
  CHECK ("failure_kind" IS NULL OR "failure_kind" IN ('code','infra','transient-cc','timeout'));
