-- ISS-137 PR-C — Layer 2 branch config per-issue override.
--
-- Free-form jsonb so future per-issue metadata (skill knobs, decomposition
-- hints, etc.) can live alongside branchConfig without further migrations.
-- NULL = no override; behaves identically to a missing key in the resolver
-- (see packages/core/src/branches/resolve.ts).
--
-- Rollback: ALTER TABLE issues DROP COLUMN metadata; — data in the column
-- is lost on rollback (acceptable because the column is opt-in and no
-- automation path depends on it yet).

ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
