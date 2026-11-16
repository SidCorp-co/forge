-- ISS-1251 (owner 2026-11-16: teach agents, never force them): the debts door records a red its
-- writer rated high, answered with a `RED_RATED_HIGH` warning that it holds its issue and is fixed
-- there (REQ-79 BC-3), instead of refusing it. The merge check still counts no red rated high as
-- debt, so nothing lands on one. Dropping the CHECK changes no row: every row standing today holds it.
--
-- ROLLBACK (refused while a red rated high is recorded; clear or re-rate it first):
--   ALTER TABLE delivery_debts ADD CONSTRAINT delivery_debts_red_not_high_chk
--     CHECK (kind <> 'red' OR impact_rating <> 'high');

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "delivery_debts" DROP CONSTRAINT IF EXISTS "delivery_debts_red_not_high_chk";
