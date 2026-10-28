-- An adopt may cross a contract version no differ measured additive (measured `unknown`, a check
-- unread, changes cut short) only on the consumer's stated reason, and the interface revision the
-- adopt writes keeps it (REQ-5 BC-15): why it crossed, and each version it crossed with what that
-- version's measurement left unread. A breaking version, or a pin with no measured line to the
-- target, is never crossed this way (BC-16), which the adopt door decides, not this table.
--   adopt_reason       the consumer's words; null on every revision no such adopt wrote
--   adopt_unmeasured   [{ version, measured }], at least one, present exactly when the reason is
-- No row is rewritten: every revision written before this one was written without a reason.
--
-- ROLLBACK: ALTER TABLE project_interface_revisions DROP CONSTRAINT project_interface_revisions_adopt_chk,
--   DROP COLUMN adopt_unmeasured, DROP COLUMN adopt_reason;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "project_interface_revisions" ADD COLUMN IF NOT EXISTS "adopt_reason" text;--> statement-breakpoint
ALTER TABLE "project_interface_revisions" ADD COLUMN IF NOT EXISTS "adopt_unmeasured" jsonb;--> statement-breakpoint
ALTER TABLE "project_interface_revisions" DROP CONSTRAINT IF EXISTS "project_interface_revisions_adopt_chk";--> statement-breakpoint
ALTER TABLE "project_interface_revisions" ADD CONSTRAINT "project_interface_revisions_adopt_chk" CHECK (("adopt_reason" IS NULL AND "adopt_unmeasured" IS NULL) OR (length(btrim("adopt_reason")) BETWEEN 1 AND 4000 AND jsonb_typeof("adopt_unmeasured") = 'array' AND jsonb_array_length("adopt_unmeasured") >= 1));
