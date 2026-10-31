-- A verdict may name the repository path prefixes its criterion rests on (ISS-845, REQ-79 r6). A pass
-- judged at an earlier commit carries to a later landing that descends from it, unless what changed
-- between the two falls under one of them. Every existing row covers nothing named, so descent alone
-- carries it.
--
-- ROLLBACK: drop the column and the check; every pass then carries on descent alone.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD COLUMN IF NOT EXISTS "covers" text[];--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP CONSTRAINT IF EXISTS "criterion_verdicts_covers_chk";--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_covers_chk" CHECK ("criterion_verdicts"."covers" IS NULL OR cardinality("criterion_verdicts"."covers") >= 1);
