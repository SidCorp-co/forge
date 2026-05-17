-- ISS-158 (sub 1 of ISS-149) — fresh-auth stamp on the users row.
--
-- `last_fresh_auth_at` records the last time the user re-entered their
-- password via POST /api/auth/reauth. The `requireFreshAuth(minutes)`
-- middleware gates sensitive surfaces (PAT creation, device revoke, password
-- change — wired by sibling children) by checking this stamp against a
-- recency window.
--
-- Nullable: existing rows have never re-authed, so the middleware treats
-- absence as "stale" and forces a fresh prompt. Single column, no index —
-- only ever read via the row's PK lookup.
--
-- Rollback: ALTER TABLE "users" DROP COLUMN "last_fresh_auth_at";

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_fresh_auth_at" timestamptz;
