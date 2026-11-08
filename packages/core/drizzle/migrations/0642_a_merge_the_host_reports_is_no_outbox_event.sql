-- ISS-822 (REQ-12 BC-18). `source.merged` leaves the outbox. No consumer has read it since ISS-774:
-- OUTBOX_CONSUMERS named none, so the emit sent no delivery job for any row of it, and the three
-- adapters that emitted it stop in this change. Its rows are read by nothing, and each would leave
-- with the seven-day retention sweep (OUTBOX_RETENTION_DAYS); they leave here with the type row the
-- registry no longer names, which `pipeline_outbox.type` references.
--
-- A delivery job is a copy of its event, so none needs the row. One still waiting to run for a
-- `source.merged` event (sent to a consumer before ISS-774 and never finished) would be delivered to
-- a consumer that no longer exists: where one does, the deploy aborts naming how many, rather than
-- retiring a type something may yet deliver.
--
-- ROLLBACK: INSERT INTO "outbox_event_types" ("type") VALUES ('source.merged');

DO $$
DECLARE
  waiting bigint := 0;
BEGIN
  IF to_regclass('pgboss_v12.job') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM pgboss_v12.job
                WHERE data->>'type' = 'source.merged'
                  AND state::text IN ('created', 'retry', 'active')$q$
       INTO waiting;
  END IF;
  IF waiting > 0 THEN
    RAISE EXCEPTION 'OUTBOX_TYPE_STILL_DELIVERED: % pg-boss job(s) still wait to deliver a source.merged event, which no consumer reads since ISS-774; cancel each (UPDATE pgboss_v12.job SET state = ''cancelled'' WHERE data->>''type'' = ''source.merged'' AND state IN (''created'', ''retry'', ''active'')) once you have read what it carries, then deploy again.', waiting;
  END IF;
END $$;--> statement-breakpoint
DELETE FROM "pipeline_outbox" WHERE "type" = 'source.merged';--> statement-breakpoint
DELETE FROM "outbox_event_types" WHERE "type" = 'source.merged';
