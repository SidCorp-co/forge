-- ISS-1064 — a knowledge entry names what it rests on (`source`), where it applies (`scope`) and the
-- change that means it needs re-checking (`recheck_when`), on the project store and the org store.
--
-- Nullable on purpose: every row already written keeps NULL in all three, stays readable, and is
-- listed by `scripts/check-memory-anchors.mjs` as owing them — the priced amnesty
-- `knowledge-entries-without-provenance` in `.forge/conformance.json`, ended when each such row is
-- rewritten or deleted. A new write of a reference, guide, workflow or rule (and every org entry) is
-- refused without them by the write path (`knowledge/provenance.ts`), never by a NOT NULL here.
--
-- ROLLBACK: ALTER TABLE "knowledge_entries" DROP COLUMN IF EXISTS "source", DROP COLUMN IF EXISTS
-- "scope", DROP COLUMN IF EXISTS "recheck_when"; and the same on "org_knowledge_entries".

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN IF NOT EXISTS "scope" text;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN IF NOT EXISTS "recheck_when" text;--> statement-breakpoint
ALTER TABLE "org_knowledge_entries" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint
ALTER TABLE "org_knowledge_entries" ADD COLUMN IF NOT EXISTS "scope" text;--> statement-breakpoint
ALTER TABLE "org_knowledge_entries" ADD COLUMN IF NOT EXISTS "recheck_when" text;
