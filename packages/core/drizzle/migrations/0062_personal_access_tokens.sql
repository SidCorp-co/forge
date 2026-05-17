-- ISS-150 — Personal Access Tokens (PAT) alongside device-token auth.
--
-- Plaintext shape: `forge_pat_<env>_<64 hex>` where <env> ∈ dev|stg|prd.
-- We store an 18-char prefix (`forge_pat_<env>_<4 hex>`) indexed for lookup
-- and an argon2id hash of the plaintext+pepper. The 4-hex selector gives
-- ~65k buckets per env — adequate for B-tree lookup at the scales we expect.
--
-- `project_ids = NULL` means "global PAT" — inherits the user's project
-- memberships. A non-null array is a strict allowlist; tools resolve cross-
-- tenant access through it and 404 (not 403) to avoid existence leaks.
--
-- Rollback: DROP TABLE "personal_access_tokens"; — no dependent FKs yet.

CREATE TABLE IF NOT EXISTS "personal_access_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_prefix" varchar(18) NOT NULL,
  "scopes" text[] NOT NULL DEFAULT ARRAY['read','write']::text[],
  "project_ids" uuid[],
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "last_used_ip" text,
  "revoked_at" timestamptz,
  "rate_limit_max" integer
);

CREATE UNIQUE INDEX IF NOT EXISTS "pat_user_name_uniq"
  ON "personal_access_tokens" ("user_id", "name");
CREATE INDEX IF NOT EXISTS "pat_user_active_idx"
  ON "personal_access_tokens" ("user_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "pat_token_prefix_idx"
  ON "personal_access_tokens" ("token_prefix");
