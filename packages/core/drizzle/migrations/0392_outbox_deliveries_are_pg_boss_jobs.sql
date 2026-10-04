-- ISS-192: a delivery is a pg-boss job on its consumer's queue (`outbox/queues.ts`), so the
-- hand-rolled delivery table goes. pg-boss 12 creates its schema when core starts, after this runs,
-- so no row can be moved from here: an undelivered delivery, pending or dead, refuses the migration
-- by name. The build that wrote it is still serving while this deploy fails, and it delivers a
-- pending one in seconds; a dead one is replayed there first. The lock keeps that build from adding
-- a delivery between the count and the drop.
LOCK TABLE "outbox_deliveries" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  waiting int;
  first record;
BEGIN
  SELECT count(*) INTO waiting FROM "outbox_deliveries" WHERE "status" <> 'delivered';
  IF waiting > 0 THEN
    SELECT d."id", d."consumer", d."status", o."type" INTO first
      FROM "outbox_deliveries" d JOIN "pipeline_outbox" o ON o."id" = d."event_id"
     WHERE d."status" <> 'delivered'
     ORDER BY d."seq"
     LIMIT 1;
    RAISE EXCEPTION 'outbox_deliveries holds % undelivered deliver(ies), which this migration cannot move into pg-boss; the first is % (% to %, %): let the running build deliver it, or replay it there if it is dead, then deploy again',
      waiting, first."id", first."type", first."consumer", first."status";
  END IF;
END $$;--> statement-breakpoint
DROP TABLE "outbox_deliveries";
