-- ISS-1373 — a token's reach is fixed at the moment it is minted.
--
-- Each prefix of the grant menu (`auth/pat-permissions.ts`) declares the epoch it
-- joined at, and a token reaches a prefix only when its own `grant_epoch` is at
-- least that. Every row already written is epoch 1, the menu as it stood before
-- any prefix was added, so a `*`, legacy or named token keeps exactly the reach
-- it had. The default stays 1 so a row written by code that does not stamp it,
-- including the previous image during a rolling deploy, is the narrow one.
--
-- A pairing code and a device login are redeemed later, by the box, with no
-- requester in hand; the epoch of whoever created or approved them rides on the
-- code so the credential they mint is no wider than its author.
--
-- Additive, with defaults: nothing is lost, and the previous code runs against
-- the columns unchanged.
ALTER TABLE "personal_access_tokens" ADD COLUMN IF NOT EXISTS "grant_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN IF NOT EXISTS "grant_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "device_login_codes" ADD COLUMN IF NOT EXISTS "grant_epoch" integer DEFAULT 1 NOT NULL;
