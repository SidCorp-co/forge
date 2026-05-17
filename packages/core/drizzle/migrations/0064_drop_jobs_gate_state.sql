-- ISS-162 (D1 of ISS-141): drop persisted dispatcher gate state.
-- Stateless Gates moves all gate evaluation into the picker SQL; no gate
-- signal survives across ticks. queued-watchdog's `gate_at` freshness
-- clause is dropped in the same change (the project-activity NOT EXISTS
-- still covers the common case; D2 will delete the watchdog entirely).
DROP INDEX IF EXISTS "jobs_gate_at_idx";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "gate_reason";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "gate_at";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "gate_metadata";
