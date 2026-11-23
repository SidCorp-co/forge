-- ISS-1436 (REQ-90 BC-15). A speaker a project admin declared by chat identity for `accept` accepts a
-- requirement revision in the project's room with no Forge account: the revision's decision, and the
-- baseline an accept on an agreed requirement writes, name that chat identity's account
-- (`chat_temporary_accounts`) and the name the room showed. Once the identity links a Forge account,
-- the user is written beside it, so the acceptance reads as theirs; the chat identity stays as the
-- evidence of whose word it was. Existing rows are people's and keep their user. A baseline stays
-- insert-only but for that one write: its user, from none to the account its chat identity is linked
-- to, and nothing else on the row.
--
-- ROLLBACK: refused while a row names a chat identity and no user (it has no user to name); then
-- put back 0349's `requirement_baseline_guard()`, re-add 0349's `requirement_revisions_decided_chk`
-- and 0483's `requirement_baselines_agreed_kind_chk`,
-- and DROP COLUMN `decided_by_chat_account`, `decided_by_chat_name` on
-- `requirement_revisions` and `agreed_by_chat_account`, `agreed_by_chat_name` on
-- `requirement_baselines`.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN IF NOT EXISTS "decided_by_chat_account" uuid REFERENCES "chat_temporary_accounts"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN IF NOT EXISTS "decided_by_chat_name" text;--> statement-breakpoint
ALTER TABLE "requirement_revisions" DROP CONSTRAINT IF EXISTS "requirement_revisions_decided_chk";--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_decided_chk" CHECK (
  ("state" NOT IN ('current', 'superseded')
   OR (("decided_by" IS NOT NULL OR "decided_by_chat_account" IS NOT NULL) AND "decided_at" IS NOT NULL))
  AND ("decided_by_chat_account" IS NULL) = ("decided_by_chat_name" IS NULL)
);--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD COLUMN IF NOT EXISTS "agreed_by_chat_account" uuid REFERENCES "chat_temporary_accounts"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD COLUMN IF NOT EXISTS "agreed_by_chat_name" text;--> statement-breakpoint
ALTER TABLE "requirement_baselines" DROP CONSTRAINT IF EXISTS "requirement_baselines_agreed_kind_chk";--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD CONSTRAINT "requirement_baselines_agreed_kind_chk" CHECK (
  (("agreed_kind" = 'person' AND ("agreed_by" IS NOT NULL OR "agreed_by_chat_account" IS NOT NULL))
   OR ("agreed_kind" = 'kernel' AND "agreed_by" IS NULL AND "agreed_by_chat_account" IS NULL AND "act" = 'repin'))
  AND ("agreed_by_chat_account" IS NULL) = ("agreed_by_chat_name" IS NULL)
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "requirement_baseline_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id") THEN
    RETURN OLD;
  END IF;
  -- a declared speaker's baseline takes the user their chat identity is linked to, once (ISS-1436)
  IF TG_TABLE_NAME = 'requirement_baselines' AND TG_OP = 'UPDATE' THEN
    IF OLD."agreed_by" IS NULL AND OLD."agreed_by_chat_account" IS NOT NULL
       AND NEW."agreed_by" IS NOT NULL
       AND NEW."agreed_by" = (SELECT "linked_user_id" FROM "chat_temporary_accounts" WHERE "id" = OLD."agreed_by_chat_account")
       AND (to_jsonb(NEW) - 'agreed_by') = (to_jsonb(OLD) - 'agreed_by') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'BASELINE_IMMUTABLE: a baseline of requirement % and its pins are insert-only; agreeing again writes a new one', OLD."requirement_id" USING ERRCODE = 'check_violation';
END $$;
