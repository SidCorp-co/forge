-- ISS-1329. A master asked for production approval of an integration whose sending path had run only
-- against a simulation, and nothing on its release said so. A verdict now says how its criterion's
-- call to an outside provider was proven: `live` against the provider or its test account,
-- `simulated` against a mock. A release page line reads `simulated` while any of its issue's criteria
-- rests on a mock (`release-page/proofs.ts`). Every earlier verdict said nothing, so null.
--
-- ROLLBACK: ALTER TABLE "criterion_verdicts" DROP CONSTRAINT IF EXISTS "criterion_verdicts_integration_proof_chk";
--   ALTER TABLE "criterion_verdicts" DROP COLUMN IF EXISTS "integration_proof";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD COLUMN IF NOT EXISTS "integration_proof" text;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP CONSTRAINT IF EXISTS "criterion_verdicts_integration_proof_chk";--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_integration_proof_chk"
  CHECK ("integration_proof" IS NULL OR "integration_proof" IN ('live', 'simulated'));
