-- ISS-1251 (criteria 3 and 7). What agents do with Forge's doors is read by refusal code and by what
-- they missed, so both are kept where the act is already recorded:
--   1. mcp_audit_log.refusal_code: the code a refused call answered with (`SUPPORT_MESSAGE_UNKNOWN`,
--      `LESSON_NOT_APPLICABLE`), beside the coarse result_code it already keeps; null for a call that
--      ended ok, and for every row written before this.
--   2. support_reply_verdicts.missed: the capabilities a room agent's own audit of a reply says it
--      should have reached for and did not, each { door, why }; '[]' where it named none, and for every
--      verdict kept before this.
-- No existing row's value changes; both columns are additive.
--
-- ROLLBACK (nothing references either column):
--   ALTER TABLE "mcp_audit_log" DROP COLUMN IF EXISTS "refusal_code";
--   ALTER TABLE "support_reply_verdicts" DROP COLUMN IF EXISTS "missed";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "mcp_audit_log" ADD COLUMN IF NOT EXISTS "refusal_code" text;--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ADD COLUMN IF NOT EXISTS "missed" jsonb DEFAULT '[]'::jsonb NOT NULL;
