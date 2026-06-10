-- Org-tier email-token invitations (mirror of project_invitations) so a team
-- can onboard people who have no Forge account yet: org add-member falls back
-- to an invitation when the email is unregistered; accepting (after signup)
-- inserts the organization_members row.

CREATE TABLE IF NOT EXISTS "org_invitations" (
  "token" text PRIMARY KEY,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "email" text NOT NULL,
  "role" text NOT NULL,
  "inviter_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invitations_org_email_idx" ON "org_invitations" ("org_id", "email");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_invitations_org_email_pending_uq"
  ON "org_invitations" ("org_id", "email") WHERE accepted_at IS NULL;
