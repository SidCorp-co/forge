-- ISS-992 follow-up — the tombstone is the project FK's, and nobody else's.
--
-- `issue_prefix_aliases_immutable` accepted any `project_id` non-null -> NULL, because that is the
-- shape `ON DELETE SET NULL` writes when a project is deleted. But an operator, a restore or later
-- code can write the same shape by hand while the project is still there, and that orphans a live
-- project's alias: `heldIssuePrefixes` stops returning it, and a `FD-977` somebody published stops
-- resolving — the one failure this table exists to prevent, reached through the one mutation it
-- had to allow (codex review of ISS-992, after the first migration landed).
--
-- The two are distinguishable in the trigger and nowhere else: Postgres deletes the parent row
-- before the referential action fires, so the FK's own tombstone sees no `projects` row while a
-- hand-written one sees its project alive. Measured against Postgres 16 on 2026-09-13.
--
-- CREATE OR REPLACE, so this is correct whether or not 0235 has been applied anywhere yet.
CREATE OR REPLACE FUNCTION "issue_prefix_aliases_immutable"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'issue_prefix_aliases is insert-only: a prefix is never given up (ISS-992)';
	END IF;
	IF NEW."prefix" IS DISTINCT FROM OLD."prefix" THEN
		RAISE EXCEPTION 'issue_prefix_aliases.prefix is immutable: % cannot become % (ISS-992)', OLD."prefix", NEW."prefix";
	END IF;
	IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'issue_prefix_aliases rows are immutable: id and created_at never change (ISS-992)';
	END IF;
	IF NEW."project_id" IS DISTINCT FROM OLD."project_id" THEN
		IF NEW."project_id" IS NOT NULL THEN
			RAISE EXCEPTION 'issue_prefix_aliases.project_id may only go NULL (the tombstone), never to another project (ISS-992)';
		END IF;
		IF EXISTS (SELECT 1 FROM projects WHERE id = OLD."project_id") THEN
			RAISE EXCEPTION 'the tombstone belongs to the project FK and is written only when the project is deleted — project % is still here, and orphaning its alias by hand is what stops a published reference resolving (ISS-992)', OLD."project_id";
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
