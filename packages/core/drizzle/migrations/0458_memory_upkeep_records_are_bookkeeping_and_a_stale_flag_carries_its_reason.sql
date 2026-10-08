-- MJ-4. Memory's own upkeep wrote its records as `decision` memories: every release's reconcile
-- (`reconcile:ISS-n`, metadata.cause = 'memory-reconcile') and every consolidation sweep
-- (`consolidation:<day>-<hex>`, metadata.cause = 'memory-consolidation'). On dev that was 177 of the
-- 195 decision rows of hop and forge, so a person or the assistant asking what was decided read
-- bookkeeping. Those rows move to the source `bookkeeping`, which no caller may write and no search
-- returns unless asked for by name. Rows are selected by metadata.cause only, never by their text.
--
-- A reconcile row's ref is the key the reconcile reads to stay once-per-issue, so it must be
-- `reconcile:ISS-<n>` and carry metadata.issueId; a consolidation row's ref must start
-- `consolidation:`; and no bookkeeping row may already hold the same ref in the project. A row of
-- either cause that is not that shape aborts the deploy naming it: it is moved by hand or not at all.
--
-- The same release reconcile stamped rows "possibly stale" (metadata.staleSince + supersededBy) with
-- no reason, and decay archived such a row 14 days later unless someone confirmed it. From this
-- change a flag carries metadata.staleReason or is not made. A flag already standing without one
-- said nothing anyone could check, so it is dropped and kept on the row as metadata.flagDropped
-- {since, by, why}: the row reads unflagged and decay no longer archives it on that guess.
--
-- Idempotent: a moved row is no longer `decision`, and a dropped flag no longer has staleSince, so a
-- second run moves and drops nothing and its NOTICEs say 0.
--
-- ROLLBACK: UPDATE memories SET source = 'decision' WHERE source = 'bookkeeping'
--             AND metadata->>'cause' IN ('memory-reconcile', 'memory-consolidation');
--           UPDATE memories SET metadata = (metadata - 'flagDropped')
--             || jsonb_build_object('staleSince', metadata->'flagDropped'->>'since', 'supersededBy', metadata->'flagDropped'->>'by')
--             WHERE metadata ? 'flagDropped';

DO $$
DECLARE
  bad record;
  moved integer;
  cause text;
BEGIN
  SELECT m.id, m.project_id, m.source_ref, m.metadata->>'cause' AS cause INTO bad
    FROM memories m
   WHERE m.source = 'decision'
     AND m.metadata->>'cause' IN ('memory-reconcile', 'memory-consolidation')
     AND (
       (m.metadata->>'cause' = 'memory-reconcile'
         AND (m.source_ref !~ '^reconcile:ISS-[0-9]+$' OR coalesce(m.metadata->>'issueId', '') = ''))
       OR (m.metadata->>'cause' = 'memory-consolidation' AND m.source_ref !~ '^consolidation:.+')
       OR EXISTS (
         SELECT 1 FROM memories b
          WHERE b.project_id = m.project_id AND b.source = 'bookkeeping' AND b.source_ref = m.source_ref
       )
     )
   ORDER BY m.created_at, m.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0458: memory % (project %, ref %, cause %) cannot become bookkeeping: a reconcile row is reconcile:ISS-<n> with metadata.issueId, a consolidation row is consolidation:<...>, and no bookkeeping row may already hold its ref',
      bad.id, bad.project_id, bad.source_ref, bad.cause;
  END IF;

  FOREACH cause IN ARRAY ARRAY['memory-reconcile', 'memory-consolidation'] LOOP
    UPDATE memories SET source = 'bookkeeping'
     WHERE source = 'decision' AND metadata->>'cause' = cause;
    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE '0458: % decision memor(ies) with cause % are now bookkeeping', moved, cause;
  END LOOP;
END $$;--> statement-breakpoint

DO $$
DECLARE
  dropped integer;
BEGIN
  UPDATE memories
     SET metadata = (metadata - 'staleSince' - 'supersededBy') || jsonb_build_object(
           'flagDropped', jsonb_build_object(
             'since', metadata->>'staleSince',
             'by', metadata->>'supersededBy',
             'why', 'flagged possibly stale with no reason given; the flag was dropped (0458)'))
   WHERE metadata ? 'staleSince' AND NOT metadata ? 'staleReason';
  GET DIAGNOSTICS dropped = ROW_COUNT;
  RAISE NOTICE '0458: % possibly-stale flag(s) with no reason were dropped and kept as metadata.flagDropped', dropped;
END $$;
