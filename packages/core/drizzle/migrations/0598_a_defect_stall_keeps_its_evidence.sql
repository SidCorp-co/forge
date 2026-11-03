-- A hand reopen for a defect is a defect stall (ISS-927, REQ-67 BC-6): the reopen transition names
-- `cause: defect` with its evidence, and the stall it starts keeps that evidence, so what the stall
-- stood on is read from the row, never from the reason prose.
--   stalls.evidence   the reopen's evidence ref: {"verdictId"}, {"attachmentId"} or {"liveRead"}; null
--                     on every stall a reopen with a cause did not start, the failed verdict's included.
--
-- ROLLBACK: ALTER TABLE "stalls" DROP CONSTRAINT IF EXISTS "stalls_evidence_chk";
-- ALTER TABLE "stalls" DROP COLUMN IF EXISTS "evidence";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "stalls" ADD COLUMN IF NOT EXISTS "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "stalls" DROP CONSTRAINT IF EXISTS "stalls_evidence_chk";--> statement-breakpoint
ALTER TABLE "stalls" ADD CONSTRAINT "stalls_evidence_chk" CHECK ("stalls"."evidence" IS NULL OR ("stalls"."cause" = 'defect' AND jsonb_typeof("stalls"."evidence") = 'object'));
