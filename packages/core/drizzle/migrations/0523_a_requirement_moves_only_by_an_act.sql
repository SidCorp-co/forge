-- A requirement's status is moved only by an explicit act of a person, the assistant or an agent
-- (REQ-74 BC-8..10, owner ruling 2026-10-23), so `in_delivery` and `delivered` become stored
-- statuses of machine `requirement` version 5, each entered by its own act (start-delivery,
-- mark-delivered) through the kernel transition; until now both were a phase read off the linked
-- issues and verdicts on every query, and nothing stored them. requirements_status_chk widens to
-- the two, and requirements_agreed_head_chk holds a current revision on both, as on agreed and
-- accepted.
--
-- This migration PROMOTES NO ROW. Every requirement keeps the status it holds (agreed, accepted or
-- any other): one that read in delivery or delivered before this deploy reads agreed after it, until
-- a person or an agent moves it through the new door. Nothing changes status as a side effect of the
-- deploy, which is the rule this change ships.
--
-- An accept by decision (an accept over an incomplete acceptance checklist) stores nothing new: the
-- kernel_transitions row of the move records each waived item as a checklist answer of provenance
-- `waived`, beside the answers the checklist gave.
--
-- ROLLBACK: once no row reads in_delivery or delivered (move each back to agreed through the kernel),
-- restore the five-status requirements_status_chk and the two-status requirements_agreed_head_chk.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirements" DROP CONSTRAINT IF EXISTS "requirements_status_chk";--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_status_chk" CHECK ("requirements"."status" IN ('draft', 'agreed', 'in_delivery', 'delivered', 'accepted', 'dropped', 'deferred'));--> statement-breakpoint
ALTER TABLE "requirements" DROP CONSTRAINT IF EXISTS "requirements_agreed_head_chk";--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_agreed_head_chk" CHECK ("requirements"."status" NOT IN ('agreed', 'in_delivery', 'delivered', 'accepted') OR "requirements"."current_revision" IS NOT NULL);
