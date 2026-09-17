-- ISS-1062 — the way back from 0263_repo_pull_requests.sql.
--
-- NOT run by `db/migrate.js`. This file is applied BY HAND, against the database, BEFORE the
-- previous image is started — never after. The previous image's boot migrator knows only its
-- own migrations, so starting it against the new schema makes it loop; and the runtime image
-- installs only openssh-keygen, openssh-client and git, so there is no `psql` inside it.
-- Reach the database from a one-off container on the app's own network:
--
--   docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' <core-container>
--   docker run --rm --network <that-network> -i postgres:16 \
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     < packages/core/drizzle/rollback/0263_down.sql
--
-- The file is REDIRECTED INTO the container's stdin. `-f 0263_down.sql` would make psql look
-- for the file INSIDE the disposable container, which has no checkout mounted, so recovery
-- would stop before executing a single statement.
--
-- Then:
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<0263 hash>';
-- and start the previous image.
--
-- THIS ONE LOSES NOTHING, AND THAT IS A PROPERTY OF THE TABLE RATHER THAN OF THIS FILE.
-- `repo_pull_requests` is a PROJECTION: every row in it is a restatement of something GitHub
-- already holds and will re-send. It is the only table the forward migration creates, no other
-- table references it, no column anywhere else was altered, and nothing reads it but
-- `integrations/repo-projection.ts` — whose callers render an absent projection as an empty
-- list, which is exactly the state the previous image was in. Dropping it costs a cache, and
-- the next delivery of each event rebuilds what that repository's pull requests are.
--
-- It is therefore ADDITIVE in the forward direction and reversible in this one. If that ever
-- stops being true — if a later change makes something depend on a row here surviving — this
-- header is the thing to correct, because the drop below will still succeed and will still be
-- wrong.

BEGIN;

-- === 1. refuse if something has come to depend on it =====================
-- A foreign key pointing AT this table means a later change made the projection load-bearing,
-- and this file's whole claim ("dropping it loses nothing") is no longer the truth. Name the
-- dependants and stop, rather than cascading them away to make the DROP succeed.
DO $$
DECLARE
  dependants text;
BEGIN
  SELECT string_agg(DISTINCT c.conrelid::regclass::text, ', ')
    INTO dependants
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.confrelid = to_regclass('public.repo_pull_requests')
     AND c.conrelid <> to_regclass('public.repo_pull_requests');

  IF dependants IS NOT NULL THEN
    RAISE EXCEPTION
      'ISS-1062 rollback: these tables reference repo_pull_requests and would be broken by the drop: %. '
      'That reference was added after 0263, so this file no longer describes the way back — '
      'undo the change that added it first.', dependants;
  END IF;
END $$;

-- === 2. the drop =========================================================
-- Its three outgoing foreign keys go with it; nothing else is touched.
DROP TABLE IF EXISTS repo_pull_requests;

COMMIT;
