-- ISS-597: in-app invitation inbox.
-- Add dismissed_at to both invitation tables so invitees can decline
-- without losing the audit trail. Nullable: existing rows carry none.
ALTER TABLE "org_invitations" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamp with time zone;
ALTER TABLE "project_invitations" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamp with time zone;
