-- What a lesson is about lives on its record, set by the steward that drafts it from its corrections:
-- `app` (the app's own behaviour, which a check in the project's code can catch) or `process` (an
-- agent's judgement or a Forge step). ISS-1136 read it off the scope, so every lesson scoped to the
-- project or to an item kind was routed to Forge as a process lesson, those about the app's own
-- screens included (ISS-1167: agenfold's L-25 and L-29, as FB-588 and FB-589).
--
-- Backfill: an area lesson is `app`, as it was already read. Every other row stays NULL: its scope is
-- no evidence of what it is about, and a NULL lesson owed a check is owed its classification first,
-- filed neither way until the steward gives one.
--
-- ROLLBACK: ALTER TABLE "lessons" DROP CONSTRAINT "lessons_about_chk"; ALTER TABLE "lessons" DROP COLUMN "about";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "about" text;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_about_chk" CHECK ("about" IS NULL OR "about" IN ('app', 'process'));--> statement-breakpoint
UPDATE "lessons" SET "about" = 'app' WHERE "scope_kind" = 'area';
