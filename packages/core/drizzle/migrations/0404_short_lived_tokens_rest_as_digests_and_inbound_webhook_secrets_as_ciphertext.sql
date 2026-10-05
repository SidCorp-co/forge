-- Personal-data-flow audit: email-verification tokens, org and project invitation tokens and
-- pairing codes rest as their sha256 hex digest, never as the token; an inbound webhook secret gains
-- the ciphertext column it moves into; a PAT records whether its hash is proven under the configured
-- PAT_PEPPER.
--
-- Existing rows are converted in place, so a token or code already handed out keeps working: core
-- digests what it is handed and looks the digest up. The webhook secret needs the app's
-- INTEGRATION_MASTER_KEY, which SQL does not hold, so core encrypts it at boot and nulls the
-- plaintext column (project-config/binding-store.ts:encryptPlaintextBindingSecrets); that column is dropped by a later
-- migration once no row holds it.
--
-- ROLLBACK: none for the digests. A digest cannot be turned back into its token; undoing this
-- leaves every outstanding verification link, invitation and pairing code invalid, all of which are
-- short-lived and can be issued again.

-- LOCKS. Every table this file touches is locked up front in one fixed (alphabetical) order; a table
-- that stays busy past lock_timeout fails the deploy loudly. A table this database never had is
-- skipped.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'email_verification_tokens', 'integration_bindings', 'org_invitations', 'pairing_codes',
    'personal_access_tokens', 'project_invitations'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', to_regclass(t));
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

ALTER TABLE "email_verification_tokens" RENAME COLUMN "token" TO "token_hash";--> statement-breakpoint
UPDATE "email_verification_tokens" SET "token_hash" = encode(sha256(convert_to("token_hash", 'UTF8')), 'hex');--> statement-breakpoint
ALTER TABLE "org_invitations" RENAME COLUMN "token" TO "token_hash";--> statement-breakpoint
UPDATE "org_invitations" SET "token_hash" = encode(sha256(convert_to("token_hash", 'UTF8')), 'hex');--> statement-breakpoint
ALTER TABLE "project_invitations" RENAME COLUMN "token" TO "token_hash";--> statement-breakpoint
UPDATE "project_invitations" SET "token_hash" = encode(sha256(convert_to("token_hash", 'UTF8')), 'hex');--> statement-breakpoint
ALTER TABLE "pairing_codes" RENAME COLUMN "code" TO "code_hash";--> statement-breakpoint
UPDATE "pairing_codes" SET "code_hash" = encode(sha256(convert_to("code_hash", 'UTF8')), 'hex');--> statement-breakpoint

ALTER TABLE "integration_bindings" ADD COLUMN "integration_secret_enc" bytea;--> statement-breakpoint

-- Every hash written before this file is unproven: it may verify only under the legacy built-in
-- pepper. A token minted from here on is hashed under the configured one.
ALTER TABLE "personal_access_tokens" ADD COLUMN "pepper_proven" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ALTER COLUMN "pepper_proven" SET DEFAULT true;
