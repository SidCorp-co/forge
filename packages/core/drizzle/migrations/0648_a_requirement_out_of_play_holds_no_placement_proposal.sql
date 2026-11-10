-- A requirement out of play holds no placement proposal (ISS-1191). The assistant proposed an area
-- and short name for every requirement without one, dropped and refused included. A drop or refusal
-- left the proposal standing, so the requirements list counted it as waiting for review and Accept all
-- took it. Core now withdraws the proposal in the move itself
-- (`packages/core/src/requirements/placement.ts:PLACEMENT_WITHDRAWN`) and proposes for no requirement
-- that has left play. This clears the proposals already standing on such rows. Re-running it finds
-- nothing left to clear.
--
-- ROLLBACK: none kept; a proposal on a requirement out of play is never read back.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
UPDATE "requirements"
   SET "proposed_area_id" = NULL,
       "proposed_short_name" = NULL
 WHERE "status" IN ('dropped', 'refused')
   AND ("proposed_area_id" IS NOT NULL OR "proposed_short_name" IS NOT NULL);
