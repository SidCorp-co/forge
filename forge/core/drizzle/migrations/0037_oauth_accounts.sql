-- ISS-314 — OAuth/OIDC providers (GitHub + Google + generic OIDC).
--
-- Two-part change:
--
-- 1. Drop NOT NULL on users.password_hash. OAuth-only users have no local
--    password; their identity is anchored entirely on rows in
--    oauth_accounts. The login route still rejects empty hashes so
--    password-less rows can never sign in via /auth/local.
--
-- 2. Add oauth_accounts to map (provider, provider_account_id) → user. One
--    user can link many providers (GitHub + Google + corporate SSO) which
--    is why this is a child table, not a column on users.
--
-- Reversible: dropping the table + setting the column NOT NULL again is a
-- normal down-migration if we ever want to roll back, provided no
-- password-less user has been created.

ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint

CREATE TABLE "oauth_accounts" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"             uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider"            text NOT NULL,
  "provider_account_id" text NOT NULL,
  "email"               text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "oauth_accounts_provider_account_uniq" UNIQUE ("provider", "provider_account_id")
);--> statement-breakpoint

CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts" USING btree ("user_id");
