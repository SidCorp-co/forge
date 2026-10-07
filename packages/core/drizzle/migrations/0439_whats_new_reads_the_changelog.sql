-- What's new reads the CHANGELOG.md of the running build, and the weekly digest is a changelog
-- fragment folded into a release, so no table holds a digest any more. Drops whats_new_digests (added
-- in 0437), whose only writer was the digest route this change removes.
--
-- Refuses by name when the table holds a row: a digest written there is content nothing else
-- carries, and a drop that lost it silently would be the deploy's choice, not the migration's.
-- An operator who has read the rows moves them into a changelog.d/digest-<year>-w<nn>.digest.md
-- fragment or deletes them, then re-runs the migration.
--
-- ROLLBACK: recreate whats_new_digests from the CREATE TABLE in 0437_whats_new_reads_by_time.sql;
-- no row can come back, since the migration refuses to run while one exists.

DO $$
DECLARE
	held integer;
BEGIN
	IF to_regclass('public.whats_new_digests') IS NOT NULL THEN
		SELECT count(*) INTO held FROM whats_new_digests;
		IF held > 0 THEN
			RAISE EXCEPTION 'whats_new_digests holds % row(s); 0439 drops the table because What''s new now reads digests from CHANGELOG.md. Move or delete the rows (select project_id, week, title from whats_new_digests), then migrate again.', held;
		END IF;
	END IF;
END
$$;--> statement-breakpoint
DROP TABLE IF EXISTS "whats_new_digests";
