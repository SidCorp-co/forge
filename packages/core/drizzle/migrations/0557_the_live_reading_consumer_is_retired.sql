-- The live reading compared a project's branches through its source host on a read and kept that
-- comparison until a push made it stale; its `live-reading` consumer of `source.pushed` dropped the
-- held comparison. The issue page's live reach and the pulse's "not on live" now answer from the
-- releases Forge recorded shipping (owner, 2026-10-30: agents record, Forge never infers), so the
-- consumer is gone and its queue with it. A delivery still queued there names a consumer no worker
-- registers, so it goes with the queue.
--
-- ROLLBACK: none needed; the queue is declared again on boot by a build that registers the consumer.

DO $$
BEGIN
  IF to_regprocedure('pgboss_v12.delete_queue(text)') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pgboss_v12.queue WHERE name = 'outbox.live-reading') THEN
    PERFORM pgboss_v12.delete_queue('outbox.live-reading');
  END IF;
END $$;
