-- ISS-1432 (REQ-90 BC-15). A project admin declares a delegated decider by chat identity, with no
-- Forge account; that speaker's go or hold in the project's room decides a release as that identity.
-- A release approval and a draft decision name who decided it: a Forge user, or the chat identity's
-- account (`chat_temporary_accounts`) with the name the room showed at the decision. Exactly one of
-- the two names a decided row; existing rows are people's and keep their user.
--
-- ROLLBACK: refused while a row names a chat identity (it has no user to name); then drop the two
-- decider checks, re-add 0339's `release_approvals_decided_chk`, SET NOT NULL on
-- `release_draft_approvals.decided_by_user`, and DROP COLUMN `decided_by_chat_account`,
-- `decided_by_chat_name` on both tables.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "release_approvals" ADD COLUMN IF NOT EXISTS "decided_by_chat_account" uuid REFERENCES "chat_temporary_accounts"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "release_approvals" ADD COLUMN IF NOT EXISTS "decided_by_chat_name" text;--> statement-breakpoint
ALTER TABLE "release_approvals" DROP CONSTRAINT IF EXISTS "release_approvals_decided_chk";--> statement-breakpoint
ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_decided_chk" CHECK (
  ("decision" IS NULL) = ("decided_at" IS NULL)
  AND ("decision" IS NULL) = ("decided_by_user" IS NULL AND "decided_by_chat_account" IS NULL)
  AND ("decided_by_user" IS NULL OR "decided_by_chat_account" IS NULL)
  AND ("decided_by_chat_account" IS NULL) = ("decided_by_chat_name" IS NULL)
);--> statement-breakpoint
ALTER TABLE "release_draft_approvals" ADD COLUMN IF NOT EXISTS "decided_by_chat_account" uuid REFERENCES "chat_temporary_accounts"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "release_draft_approvals" ADD COLUMN IF NOT EXISTS "decided_by_chat_name" text;--> statement-breakpoint
ALTER TABLE "release_draft_approvals" ALTER COLUMN "decided_by_user" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "release_draft_approvals" DROP CONSTRAINT IF EXISTS "release_draft_approvals_decider_chk";--> statement-breakpoint
ALTER TABLE "release_draft_approvals" ADD CONSTRAINT "release_draft_approvals_decider_chk" CHECK (
  ("decided_by_user" IS NULL) <> ("decided_by_chat_account" IS NULL)
  AND ("decided_by_chat_account" IS NULL) = ("decided_by_chat_name" IS NULL)
);
