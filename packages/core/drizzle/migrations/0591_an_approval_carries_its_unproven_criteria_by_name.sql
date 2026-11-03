-- A release approval carries its unproven criteria by name (ISS-914): each criterion the approver
-- moved past the release approval checklist unproven, with its standing when decided and the
-- approver's why. Every approval decided before this carried nothing, which `[]` says exactly.
--
-- ROLLBACK: ALTER TABLE "release_approvals" DROP COLUMN IF EXISTS "carried";
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "release_approvals" ADD COLUMN IF NOT EXISTS "carried" jsonb DEFAULT '[]'::jsonb NOT NULL;
