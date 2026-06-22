-- Runner rate-limit / usage-limit / auth highlighting (ported from forge-agents).
-- `limit_reason` records WHY a runner is limited; `rate_limited_until` is the
-- parsed reset time for usage/rate limits (NULL for auth, which needs a manual
-- fix). All cleared on a healthy heartbeat or a completing job.
ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "limit_reason" text;
--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "rate_limited_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "limit_detail" text;
