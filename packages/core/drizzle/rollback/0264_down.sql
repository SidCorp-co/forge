-- ISS-1069 — the way back from 0264_environments.sql.
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
--     < packages/core/drizzle/rollback/0264_down.sql
--
-- The file is REDIRECTED INTO the container's stdin. `-f 0264_down.sql` would make psql look
-- for the file INSIDE the disposable container, which has no checkout mounted, so recovery
-- would stop before executing a single statement.
--
-- Then:
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<0264 hash>';
-- and start the previous image.
--
-- WHAT THIS RESTORES, AND THE ONE THING IT CANNOT.
--
-- Restored exactly: `preview.url`, `preview.apiUrl` and `preview.urls` go back to `stagingUrl`,
-- `stagingApiUrl` and `testingUrls`; `limits` goes back to `notes`, INCLUDING limits text typed
-- after the deploy, because the old shape has a field for it; `testCredentials` and every key
-- neither file names never moved.
--
-- Restored in meaning but not byte for byte: which of several equivalent empties a row held.
-- `{}`, `{"stagingUrl":null}` and `{"testingUrls":[]}` all became `preview: null` going forward
-- and all come back as `{}` here. No reader in the tree distinguishes them — each one reads the
-- blob through `?? {}` and then a per-key `typeof` test — so this costs the bytes and nothing else.
--
-- NOT RESTORED, AND THIS IS THE REAL PRICE: `environments.live`. The URL, API URL, commit
-- endpoint and commit path an operator filled in between the deploy and this rollback have no
-- field in the old shape, and there is nowhere to put them. Section 1 below prints each one it is
-- about to drop, by project, as a NOTICE — READ THAT OUTPUT AND WRITE THEM DOWN before section 3
-- runs, because nothing else in the system holds those values. That is exactly the gap ISS-1069
-- exists to close, so losing it is losing the thing this change was for.
--
-- If a later change makes `environments` hold something this file does not know about, this header
-- is the thing to correct — the rewrite below will still succeed and will still be wrong.

BEGIN;

-- === 1. say out loud what is about to be lost ================================
-- A NOTICE and not an EXCEPTION: a rollback is already a bad afternoon, and refusing to run
-- because somebody typed a live URL would leave the operator with the new schema, the old image
-- and no way forward. Print it, name the project, and proceed.
DO $iss1069$
DECLARE
  losing text;
BEGIN
  SELECT string_agg(format('  %s — %s', slug, environments -> 'live'), E'\n' ORDER BY slug)
    INTO losing
    FROM projects
   WHERE jsonb_typeof(environments) = 'object'
     AND jsonb_typeof(environments -> 'live') = 'object'
     AND environments -> 'live' <> jsonb_build_object(
           'url', NULL, 'apiUrl', NULL, 'commitUrl', NULL, 'commitPath', NULL);

  IF losing IS NOT NULL THEN
    RAISE NOTICE
      E'ISS-1069 rollback: the old shape has no field for a live side, so these values are about to be DROPPED. Write them down now — nothing else in this system holds them:\n%',
      losing;
  END IF;
END $iss1069$;

-- === 2. the rename, back =====================================================
-- The rename comes FIRST here, not last: section 3 both reads and writes the same column, and
-- doing it the other way round would mean writing through a name the column does not carry yet.
ALTER TABLE "projects" RENAME COLUMN "environments" TO "preview_deploy";

-- === 3. every row back into the old shape ====================================
-- The inverse of section 3 of the forward migration, key for key. `preview: null` flattens to
-- nothing rather than to explicit nulls, which is the `{}` the old readers already handled.
--
-- Each preview field is emitted on its own, and a null one is simply not emitted. It is written
-- this way rather than as one `jsonb_strip_nulls(jsonb_build_object(…))` because that function
-- strips RECURSIVELY: a `testingUrls` row carrying `{"label":"Beta","url":"…","future":{"mode":null}}`
-- came through the forward migration untouched and would have lost `mode` here. That is a value an
-- operator stored and nothing would have told them it was gone — the opposite of what a rollback is
-- for. `urls` is therefore copied VERBATIM and never rebuilt.
UPDATE projects
   SET preview_deploy = (
         (preview_deploy - 'preview' - 'live' - 'limits')
         || CASE
              WHEN jsonb_typeof(preview_deploy -> 'preview' -> 'url') = 'string'
              THEN jsonb_build_object('stagingUrl', preview_deploy -> 'preview' -> 'url')
              ELSE '{}'::jsonb
            END
         || CASE
              WHEN jsonb_typeof(preview_deploy -> 'preview' -> 'apiUrl') = 'string'
              THEN jsonb_build_object('stagingApiUrl', preview_deploy -> 'preview' -> 'apiUrl')
              ELSE '{}'::jsonb
            END
         || CASE
              WHEN jsonb_typeof(preview_deploy -> 'preview' -> 'urls') = 'array'
              THEN jsonb_build_object('testingUrls', preview_deploy -> 'preview' -> 'urls')
              ELSE '{}'::jsonb
            END
         || CASE
              WHEN jsonb_typeof(preview_deploy -> 'limits') = 'string'
              THEN jsonb_build_object('notes', preview_deploy -> 'limits')
              ELSE '{}'::jsonb
            END
       )
 WHERE preview_deploy IS NOT NULL
   AND jsonb_typeof(preview_deploy) IS DISTINCT FROM 'null';

COMMIT;
