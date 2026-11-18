-- ISS-1335 (FB-745). A gwork run opened a box with a checkout credential minted before /api/boxes
-- joined the grant menu: the open passed under /api/projects, every act, span and close after it was
-- refused PAT_GRANT_PREDATES_ROUTE, and the box stayed open, holding its device's headroom, with
-- nothing to close it. The sweep now closes an agent's box nothing used for an hour (`box.idle`),
-- and `closed_why` says why a box closed: `done` by a caller, `idle` by the sweep. Every box closed
-- before this was closed by a caller, so it reads `done`.
--
-- ROLLBACK: ALTER TABLE "boxes" DROP CONSTRAINT IF EXISTS "boxes_closed_why_chk";
--   ALTER TABLE "boxes" DROP COLUMN IF EXISTS "closed_why";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "closed_why" text;--> statement-breakpoint
UPDATE "boxes" SET "closed_why" = 'done' WHERE "state" = 'closed' AND "closed_why" IS NULL;--> statement-breakpoint
ALTER TABLE "boxes" DROP CONSTRAINT IF EXISTS "boxes_closed_why_chk";--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_closed_why_chk"
  CHECK (("state" = 'closed') = ("closed_why" IS NOT NULL) AND ("closed_why" IS NULL OR "closed_why" IN ('done', 'idle')));
