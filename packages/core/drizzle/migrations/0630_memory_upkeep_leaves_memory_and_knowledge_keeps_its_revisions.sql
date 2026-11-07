-- ISS-1121 (REQ-89 BC-2, BC-3, BC-4, BC-5) — curated memory and knowledge.
--
-- 1. Core's own upkeep records (a release's reconcile, a consolidation sweep) stop being memory
--    rows. 0458 gave them the source `bookkeeping`, but every memory listing and count still read
--    them beside what people and agents wrote. They move to `memory_upkeep_records`, owned by
--    `memory` (`packages/core/src/db/schema-memory-upkeep.ts:memoryUpkeepRecords`), which is history
--    only: no memory list, count or recall reads it. A reconcile's idempotency reads its record there
--    (`memory/upkeep.ts:upkeepRecorded`), and a memory a person deletes for good leaves its reason
--    there (`kind` `deletion`), never in memory; and a landing's re-check (BC-5) records what it
--    flagged there once per issue (`kind` `recheck`). A bookkeeping row whose cause is neither upkeep job
--    aborts the deploy naming it, and no row is deleted that was not first copied.
-- 2. A knowledge entry records its type, `fact`, `hypothesis` or `convention` (`entry_type`). Rows
--    written before stay null and read as owing it.
-- 3. A knowledge entry keeps the text each rewrite replaced (`knowledge_entry_revisions`), as a
--    memory does (0208): a write on a subject already held updates that entry, and its old text is
--    kept, not lost.
-- 4. An org entry carries the re-check a landing or a rule change flagged on it (`recheck_due`); a
--    project entry carries it on `metadata.recheckDue`, and a rewrite of either clears it.
--
-- ROLLBACK: INSERT INTO memories (project_id, source, source_ref, text_content, metadata, created_at, updated_at)
--             SELECT project_id, 'bookkeeping', ref, text_content, metadata, created_at, created_at FROM memory_upkeep_records;
--           DROP TABLE IF EXISTS memory_upkeep_records;
--           DROP TRIGGER IF EXISTS knowledge_entries_record_replacement ON knowledge_entries;
--           DROP FUNCTION IF EXISTS forge_record_knowledge_replacement();
--           DROP TABLE IF EXISTS knowledge_entry_revisions;
--           ALTER TABLE knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_entry_type_chk, DROP COLUMN IF EXISTS entry_type;
--           ALTER TABLE org_knowledge_entries DROP COLUMN IF EXISTS recheck_due;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_upkeep_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"text_content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_upkeep_records_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
	CONSTRAINT "memory_upkeep_records_kind_chk" CHECK ("kind" IN ('reconcile', 'consolidation', 'deletion', 'recheck'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_upkeep_records_project_ref_uq" ON "memory_upkeep_records" USING btree ("project_id", "ref");--> statement-breakpoint
DO $$
DECLARE
  bad record;
  moved integer;
BEGIN
  SELECT m.id, m.project_id, m.source_ref, m.metadata->>'cause' AS cause INTO bad
    FROM memories m
   WHERE m.source = 'bookkeeping'
     AND coalesce(m.metadata->>'cause', '') NOT IN ('memory-reconcile', 'memory-consolidation')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0630: bookkeeping memory % (project %, ref %) has cause %, which is neither upkeep job; it cannot move to memory_upkeep_records',
      bad.id, bad.project_id, bad.source_ref, coalesce(bad.cause, 'none');
  END IF;
  INSERT INTO memory_upkeep_records (project_id, kind, ref, text_content, metadata, created_at)
  SELECT m.project_id,
         CASE m.metadata->>'cause' WHEN 'memory-reconcile' THEN 'reconcile' ELSE 'consolidation' END,
         m.source_ref, m.text_content, m.metadata, m.created_at
    FROM memories m
   WHERE m.source = 'bookkeeping'
  ON CONFLICT (project_id, ref) DO NOTHING;
  SELECT count(*) INTO moved
    FROM memories m
   WHERE m.source = 'bookkeeping'
     AND NOT EXISTS (
       SELECT 1 FROM memory_upkeep_records u WHERE u.project_id = m.project_id AND u.ref = m.source_ref
     );
  IF moved > 0 THEN
    RAISE EXCEPTION '0630: % bookkeeping memor(ies) were not copied to memory_upkeep_records; nothing deleted', moved;
  END IF;
  DELETE FROM memories WHERE source = 'bookkeeping';
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE '0630: % bookkeeping memor(ies) moved to memory_upkeep_records', moved;
END $$;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN IF NOT EXISTS "entry_type" text;--> statement-breakpoint
ALTER TABLE "knowledge_entries" DROP CONSTRAINT IF EXISTS "knowledge_entries_entry_type_chk";--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_entry_type_chk"
  CHECK ("entry_type" IS NULL OR "entry_type" IN ('fact', 'hypothesis', 'convention'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_entry_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"entry_type" text,
	"scope" text,
	"recheck_when" text,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_entry_revisions_entry_fk" FOREIGN KEY ("entry_id") REFERENCES "knowledge_entries"("id") ON DELETE cascade,
	CONSTRAINT "knowledge_entry_revisions_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_entry_revisions_entry_replaced_idx" ON "knowledge_entry_revisions" USING btree ("entry_id", "replaced_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_record_knowledge_replacement() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO knowledge_entry_revisions (entry_id, project_id, slug, title, body, entry_type, scope, recheck_when)
  VALUES (OLD.id, OLD.project_id, OLD.slug, OLD.title, OLD.body, OLD.entry_type, OLD.scope, OLD.recheck_when);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS knowledge_entries_record_replacement ON knowledge_entries;--> statement-breakpoint
CREATE TRIGGER knowledge_entries_record_replacement
  AFTER UPDATE ON knowledge_entries
  FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body OR OLD.title IS DISTINCT FROM NEW.title)
  EXECUTE FUNCTION forge_record_knowledge_replacement();--> statement-breakpoint
ALTER TABLE "org_knowledge_entries" ADD COLUMN IF NOT EXISTS "recheck_due" jsonb;
