-- ISS-992 follow-up — the tombstone guard reads the REAL projects table, not the caller's.
--
-- 0237 told the FK's own tombstone apart from a hand-written one by asking whether the parent row
-- is still there. It asked with an unqualified `FROM projects`, which PL/pgSQL resolves against the
-- INVOKING session's search_path at execution time, and `pg_temp` is searched ahead of `public`
-- without appearing in the setting. So any session holding a temporary table named `projects` made
-- the guard read an empty relation, answer "the project is gone", and admit exactly the hand-written
-- tombstone 0237 exists to refuse — orphaning a live project's alias and stopping every reference
-- published under it resolving. Measured against Postgres 16 on 2026-09-13: with the shadow in
-- place the UPDATE succeeded and the row read project_id IS NULL, while `SHOW search_path` still
-- said `"$user", public` (codex review of ISS-992, after 0237 landed).
--
-- The reverse is the same bug from the other side: a session whose search_path cannot resolve
-- `projects` at all fails the lookup and blocks a legitimate project deletion.
--
-- Fixed twice over, because the guard may not depend on who calls it: the lookup names
-- `public.projects`, and the function pins its own search_path so nothing it resolves later can be
-- shadowed either.
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
		IF EXISTS (SELECT 1 FROM public."projects" WHERE "id" = OLD."project_id") THEN
			RAISE EXCEPTION 'the tombstone belongs to the project FK and is written only when the project is deleted — project % is still here, and orphaning its alias by hand is what stops a published reference resolving (ISS-992)', OLD."project_id";
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
