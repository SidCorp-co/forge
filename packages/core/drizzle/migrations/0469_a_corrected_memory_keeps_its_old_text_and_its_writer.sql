-- ISS-434 (REQ-33 BC-4): a person corrects a memory from the item it names, and the old text must
-- stay readable as an earlier revision. 0208's trigger kept a replaced body for note, knowledge and
-- policy only, so correcting a decision memory — which the item's Memory tab lists and offers to
-- correct — replaced its text with nothing kept. The trigger now keeps it for every source a person
-- may correct there (`MEMORY_AUTHORED_SOURCES`); the mirrors (issue, comment, job) follow their
-- record and bookkeeping is no person's to correct.
--
-- A correction also overwrote `metadata.writtenBy` with the person who corrected it, so the card
-- named them as the writer and the agent that wrote it was named nowhere. The code no longer does;
-- the rows it already did are restored from the revision their first correction made, which holds
-- the metadata from before it. Only a row whose writer is still that corrector is touched: one an
-- agent rewrote since names that agent, rightly.
--
-- ROLLBACK: recreate the trigger with `NEW.source IN ('note', 'knowledge', 'policy')`; the restored
-- writers are the facts the revisions recorded and are not undone.

DROP TRIGGER IF EXISTS memories_record_replacement ON memories;--> statement-breakpoint
CREATE TRIGGER memories_record_replacement
  AFTER UPDATE ON memories
  FOR EACH ROW
  WHEN (
    OLD.text_content IS DISTINCT FROM NEW.text_content
    AND NEW.source IN ('note', 'knowledge', 'policy', 'decision')
  )
  EXECUTE FUNCTION forge_record_memory_replacement();--> statement-breakpoint
WITH first_correction AS (
  SELECT m.id,
         (m.metadata -> 'corrections' -> 0 ->> 'at')::timestamptz AS at,
         m.metadata -> 'corrections' -> 0 ->> 'by' AS by
    FROM memories m
   WHERE jsonb_typeof(m.metadata -> 'corrections') = 'array'
     AND jsonb_array_length(m.metadata -> 'corrections') > 0
), before_it AS (
  SELECT DISTINCT ON (f.id) f.id, f.by, r.metadata AS md
    FROM first_correction f
    JOIN memory_revisions r ON r.memory_id = f.id AND r.replaced_at >= f.at
   ORDER BY f.id, r.replaced_at ASC, r.id
)
UPDATE memories m
   SET metadata = CASE
         WHEN b.md ? 'writtenBy' THEN jsonb_set(m.metadata, '{writtenBy}', b.md -> 'writtenBy')
         ELSE m.metadata - 'writtenBy'
       END
  FROM before_it b
 WHERE m.id = b.id
   AND m.metadata ->> 'writtenBy' = b.by
   AND (b.md ->> 'writtenBy') IS DISTINCT FROM b.by;
