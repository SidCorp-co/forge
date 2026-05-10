-- ISS-89 — Seed a fixed test user for end-to-end tests (Playwright MCP, future
-- e2e suites). Idempotent: re-runs after the first apply only refresh the
-- password_hash + email_verified_at, never overwrite if the row was deleted
-- and recreated by a human operator (UUID is fixed so re-application picks up
-- the same row).
--
-- The bot user has standard user-level permissions only — NOT a CEO, NOT
-- granted any project membership here. Project membership is added in a
-- separate seed/setup step per environment so this migration stays safe to
-- ship to fresh local dev DBs without polluting them with a project row.
--
-- Plaintext password lives outside git, on the worker host, at:
--   ~/.config/forge-e2e/credentials.env
-- Future Claude sessions: see docs/e2e-testing.md and the memory file
-- `e2e_test_user.md` for retrieval instructions.
--
-- The argon2id hash below was generated with the same parameters as
-- packages/core/src/auth/password.ts (m=19456, t=2, p=1). Rotating the
-- password = generate a new hash and supersede this migration with another
-- UPSERT migration (do NOT mutate this file in place — migrations are
-- append-only).

INSERT INTO users (id, email, password_hash, email_verified_at, is_ceo, created_at)
VALUES (
  '48138337-8cde-4f78-ba9e-1eb27180fa71',
  'playwright-bot@sidcorp.co',
  '$argon2id$v=19$m=19456,t=2,p=1$I2/bi6+iS7x/zvC2jCwDlQ$xnEcgIxfiCVnYF4b0ZtpLlL+NF4aYU/MUQIquwGkDEQ',
  NOW(),
  false,
  NOW()
)
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  email_verified_at = COALESCE(users.email_verified_at, EXCLUDED.email_verified_at);
