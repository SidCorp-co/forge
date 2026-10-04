-- A requirement's delivery phase is read in one TypeScript function (requirements/standing.ts:deliveryOf),
-- not a view plus an override; an onboarding's status is read from its close and its batches
-- (onboarding/read.ts:onboardingStatusOf), never stored (ISS-164).
DROP VIEW IF EXISTS "requirement_delivery";
--> statement-breakpoint
ALTER TABLE "onboardings" DROP CONSTRAINT IF EXISTS "onboardings_done_chk";
--> statement-breakpoint
ALTER TABLE "onboardings" DROP CONSTRAINT IF EXISTS "onboardings_status_chk";
--> statement-breakpoint
ALTER TABLE "onboardings" DROP COLUMN IF EXISTS "status";
--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_done_chk" CHECK (("onboardings"."done_at" IS NULL) = ("onboardings"."done_by" IS NULL));
