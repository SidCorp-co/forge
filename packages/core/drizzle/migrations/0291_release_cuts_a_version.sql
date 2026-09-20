-- ISS-1120 — a release cuts exactly one version, and that version is its identity.
--
-- A release is the `pipeline_runs` row carrying `metadata.source = 'release-batch'`; it is the only
-- row that IS a release, so this is where the owner's answer puts the number (2026-09-20).
--
-- Two columns, and they answer two different questions on purpose. `release_version` is the
-- identity, written once when the row is inserted and never cleared — a failed release keeps its
-- number, and the allocator reads the highest EVER cut, so a burned number can never be handed
-- back. `release_released_at` is the ship, stamped only by `finishReleaseBatch`, and it exists
-- because `cancelConcludedRun` deliberately flips a `completed` run to `cancelled`: a reader that
-- asked the run's status would lose a release whose bytes are still serving.
--
-- Both are nullable with no DEFAULT and nothing is backfilled. Every release that happened before
-- this migration keeps NULL on both, which is honest — a number invented for a past release is a
-- number nobody cut — and it is also why the CHECK below validates against existing data instead
-- of aborting the deploy.
--
-- The unique index is partial so it constrains releases and ignores every other kind of run, and
-- it is the refusal behind "two releases sharing one version". The CHECK is what makes the
-- allocator's `string_to_array(release_version, '.')::int[]` ordering safe: without it a value the
-- shape would have refused throws at read time instead of at write time.
--
-- The way back: ALTER TABLE "pipeline_runs" DROP COLUMN "release_released_at", DROP COLUMN
-- "release_version"; which takes the index and the CHECK with it and loses nothing that existed
-- before this ran.
ALTER TABLE "pipeline_runs" ADD COLUMN "release_version" text;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "release_released_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_release_version_uq" ON "pipeline_runs" USING btree ("project_id","release_version") WHERE release_version IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_release_version_chk" CHECK ("pipeline_runs"."release_version" IS NULL OR "pipeline_runs"."release_version" ~ '^[0-9]+[.][0-9]+[.][0-9]+$');
