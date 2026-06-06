-- ISS-387 — project kind for the Epodsystem website integration.
--
-- Adds a `kind` discriminator to projects: `standard` (code repo project,
-- the default for every existing row) or `website` (an Epodsystem storefront
-- project where the live store is the source of truth and a git repo is
-- optional). NOT NULL with a default so the column backfills existing rows
-- without a separate UPDATE.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta snapshot
-- collision (see 0087-0097 headers). The runtime migrator applies this row from
-- _journal.json.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'standard' NOT NULL;
