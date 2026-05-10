-- Supersedes 0053_seed_e2e_test_user.sql.
--
-- 0053 hardcoded an argon2id password hash for an end-to-end bot account.
-- Hardcoding a credential in an OSS repo is a downstream-security smell:
-- every fork that applies the migration inherits a known login. Reset that
-- hash to NULL so the leaked plaintext is no longer a valid login anywhere
-- the migration ran.
--
-- Going forward, the bot account is provisioned at server boot from the
-- `E2E_USER_EMAIL` + `E2E_USER_PASSWORD` env vars (see
-- packages/core/src/auth/seed-e2e-user.ts and docs/guides/e2e-testing.md).
-- Operators set their own credentials in their deploy environment; nothing
-- about a specific account ships in git.
--
-- The user row from 0053 is preserved (UUID + email stay) so any project
-- memberships granted out-of-band keep working — just the password is
-- invalidated. The seed-on-boot function will refresh the hash to whatever
-- the operator's env says on the next deploy.

UPDATE users
SET password_hash = NULL
WHERE email = 'playwright-bot@sidcorp.co'
  AND password_hash = '$argon2id$v=19$m=19456,t=2,p=1$I2/bi6+iS7x/zvC2jCwDlQ$xnEcgIxfiCVnYF4b0ZtpLlL+NF4aYU/MUQIquwGkDEQ';
