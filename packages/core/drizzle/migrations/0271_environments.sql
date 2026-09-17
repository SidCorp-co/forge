-- ISS-1069 — `preview_deploy` becomes `environments`, with a live side that exists.
--
-- The column was named for half the world. It held `stagingUrl`, `stagingApiUrl`,
-- `testingUrls`, `testCredentials` and a free-text `notes`, and NOTHING anywhere in
-- this schema held the address a release ships to. The only place one fitted was
-- `verify.probes` inside a deploy binding's config, which 0 of 32 projects filled —
-- mechanically rather than lazily, because the agent is told the deploy channel and
-- never told where the result lives.
--
-- The cost was measured on 2026-09-17: `sidpeak` could not cut a release at all. It
-- refused at `RELEASE_PROBES_UNDECLARED`, and declaring the probe needed the one
-- thing Forge did not hold — its own production hostname. Its two recorded URLs both
-- served `origin/staging`, its live and preview bindings pointed at different Coolify
-- applications, and its live address was written nowhere: not on the project, not on
-- the binding, not in the repository. Finishing that release meant a person opening
-- the Coolify UI and reading the domain off the application by hand.
--
-- After this migration every row holds:
--   preview          {url, apiUrl, urls[]} | null   — null is a one-box project SAYING so
--   live             {url, apiUrl, commitUrl, commitPath}  — always an object
--   testCredentials  [] — unchanged, and under this exact spelling
--   limits           text | null  — what this environment does NOT have
--   …and every key this file does not name, carried through untouched
--
-- NOTHING IS DISCOVERED HERE. `live` lands with four nulls on every row. This
-- migration gives the address somewhere to live; a person still reads it off the
-- deployment and types it in.
--
-- NON-DESTRUCTIVE. The column is RENAMED, not replaced, and every old key is carried
-- to a new name rather than dropped. Running backwards is `rollback/0271_down.sql`,
-- which restores the old name and the old value shape.
--
-- A ROW THE NEW SHAPE CANNOT REPRESENT ABORTS THIS MIGRATION BY NAME rather than
-- being cleaned away so the deploy succeeds. Section 1 names every offending project
-- at once, so an operator fixes them in one pass instead of one redeploy each. The way
-- out of such an abort is to correct the named row — never to widen the check below.
--
-- `testCredentials` KEEPS ITS SPELLING AND ITS PLACE, and that is load-bearing rather
-- than incidental: `SCRUB_BODY_KEYS` in `@forge/observability` matches on the KEY NAME
-- and not on a path, so a credential moved under a new name would stop being redacted
-- SILENTLY — the scrubber would succeed and the secret would be in the log.
--
-- cm:guard the journal `when` for this entry is max(when) + 86400000 and NEVER a real
-- timestamp. `src/db/migrate.ts` reads the single highest `created_at` already applied
-- and skips every lower entry SILENTLY and forever, so a real timestamp lands below
-- entries already in the target database and the container serves new code against an
-- old schema (ISS-807).

-- === 1. refuse, by name, every row the new shape cannot hold =================
-- Read BEFORE the rename so the message names the column an operator can still find.
-- A jsonb `null` is NOT an offence: it says exactly what a SQL NULL says — nothing is
-- declared — and both are left alone by section 3.
DO $iss1069$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('  %s — %s', slug, reason), E'\n' ORDER BY slug)
    INTO offenders
    FROM (
      SELECT slug,
             CASE
               WHEN jsonb_typeof(preview_deploy) <> 'object'
                 THEN format('the stored value is a JSON %s, and the new shape is an object',
                             jsonb_typeof(preview_deploy))
               WHEN preview_deploy ? 'preview'
                 THEN 'it already carries a `preview` key, which this migration would overwrite'
               WHEN preview_deploy ? 'live'
                 THEN 'it already carries a `live` key, which this migration would overwrite'
               WHEN preview_deploy ? 'limits'
                 THEN 'it already carries a `limits` key, which this migration would overwrite'
               WHEN jsonb_typeof(preview_deploy -> 'stagingUrl') NOT IN ('string', 'null')
                 THEN format('`stagingUrl` is a JSON %s, and `preview.url` takes a string',
                             jsonb_typeof(preview_deploy -> 'stagingUrl'))
               WHEN jsonb_typeof(preview_deploy -> 'stagingApiUrl') NOT IN ('string', 'null')
                 THEN format('`stagingApiUrl` is a JSON %s, and `preview.apiUrl` takes a string',
                             jsonb_typeof(preview_deploy -> 'stagingApiUrl'))
               WHEN jsonb_typeof(preview_deploy -> 'notes') NOT IN ('string', 'null')
                 THEN format('`notes` is a JSON %s, and `limits` takes a string',
                             jsonb_typeof(preview_deploy -> 'notes'))
               WHEN jsonb_typeof(preview_deploy -> 'testingUrls') NOT IN ('array', 'null')
                 THEN format('`testingUrls` is a JSON %s, and `preview.urls` takes an array',
                             jsonb_typeof(preview_deploy -> 'testingUrls'))
               WHEN jsonb_typeof(preview_deploy -> 'testCredentials') NOT IN ('array', 'null')
                 THEN format('`testCredentials` is a JSON %s, and it takes an array',
                             jsonb_typeof(preview_deploy -> 'testCredentials'))
               -- An ELEMENT the new shape cannot hold is the case a type check on the ARRAY misses,
               -- and it is the one that loses a value without telling anybody. SQL carries the row
               -- across untouched and `normalizeEnvironments` then answers {label, url} strings and
               -- nothing else, so an element that is not an object DISAPPEARS — a project whose only
               -- preview address sat in `testingUrls: ["https://beta.example.com"]` reads as having
               -- no preview side at all — and an element whose `url` is an object comes back as the
               -- string `[object Object]`. Both are values an operator stored and nobody is told.
               -- The fields checked here are exactly the ones `testingUrlSchema` and
               -- `testCredentialSchema` make REQUIRED STRINGS, so a row refused below is a row
               -- `PATCH /api/projects/:id` would refuse today. Types only: a label that is merely
               -- too long survives the reading intact and is the operator's to shorten.
               WHEN EXISTS (
                      SELECT 1
                        FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(preview_deploy -> 'testingUrls') = 'array'
                                    THEN preview_deploy -> 'testingUrls'
                                    ELSE '[]'::jsonb END) AS e
                       WHERE jsonb_typeof(e) <> 'object'
                          OR jsonb_typeof(e -> 'label') IS DISTINCT FROM 'string'
                          OR jsonb_typeof(e -> 'url') IS DISTINCT FROM 'string')
                 THEN 'a `testingUrls` entry is not an object carrying a string `label` and a string `url`, which is what `preview.urls` holds — carried across, every reader would drop it or read it as the literal text `[object Object]`'
               WHEN EXISTS (
                      SELECT 1
                        FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(preview_deploy -> 'testCredentials') = 'array'
                                    THEN preview_deploy -> 'testCredentials'
                                    ELSE '[]'::jsonb END) AS e
                       WHERE jsonb_typeof(e) <> 'object'
                          OR jsonb_typeof(e -> 'label') IS DISTINCT FROM 'string'
                          OR jsonb_typeof(e -> 'username') IS DISTINCT FROM 'string'
                          OR jsonb_typeof(e -> 'password') IS DISTINCT FROM 'string')
                 THEN 'a `testCredentials` entry is not an object carrying a string `label`, `username` and `password` — carried across, every reader would drop it or read a missing field as an empty one, which is a login that looks recorded and is not'
             END AS reason
        FROM projects
       WHERE preview_deploy IS NOT NULL
         AND jsonb_typeof(preview_deploy) IS DISTINCT FROM 'null'
    ) q
   WHERE reason IS NOT NULL;

  IF offenders IS NOT NULL THEN
    -- ONE `%` and one argument: in PL/pgSQL RAISE a doubled `%` is a LITERAL percent, so a
    -- format string with four adjacent placeholders reads as two literal signs and swallows the
    -- list. The newlines come from the E'' string instead.
    RAISE EXCEPTION
      E'ISS-1069: these projects hold a `preview_deploy` value the `environments` shape cannot represent, so this migration has written nothing:\n%\nCorrect each row named above and redeploy. Do NOT widen the check in 0271_environments.sql: a value quietly cleaned away here is a value the operator never learns they lost.',
      offenders;
  END IF;
END $iss1069$;--> statement-breakpoint

-- === 2. the rename ===========================================================
ALTER TABLE "projects" RENAME COLUMN "preview_deploy" TO "environments";--> statement-breakpoint

-- === 3. every row into the new shape =========================================
-- `- 'stagingUrl' - …` removes exactly the four keys that move; `testCredentials` and
-- every key this file does not name survive because nothing removes them.
-- `preview` is null where the three preview fields say nothing — absent, JSON null and
-- empty are ONE answer, and writing it once here is what stops three readers each
-- deriving it differently.
UPDATE projects
   SET environments = (
         (environments - 'stagingUrl' - 'stagingApiUrl' - 'testingUrls' - 'notes')
         || jsonb_build_object(
              'preview',
              CASE
                WHEN jsonb_typeof(environments -> 'stagingUrl') IS DISTINCT FROM 'string'
                 AND jsonb_typeof(environments -> 'stagingApiUrl') IS DISTINCT FROM 'string'
                 AND COALESCE(
                       jsonb_array_length(
                         CASE WHEN jsonb_typeof(environments -> 'testingUrls') = 'array'
                              THEN environments -> 'testingUrls'
                              ELSE '[]'::jsonb END),
                       0) = 0
                THEN 'null'::jsonb
                ELSE jsonb_build_object(
                       'url',
                       CASE WHEN jsonb_typeof(environments -> 'stagingUrl') = 'string'
                            THEN environments -> 'stagingUrl' ELSE 'null'::jsonb END,
                       'apiUrl',
                       CASE WHEN jsonb_typeof(environments -> 'stagingApiUrl') = 'string'
                            THEN environments -> 'stagingApiUrl' ELSE 'null'::jsonb END,
                       'urls',
                       CASE WHEN jsonb_typeof(environments -> 'testingUrls') = 'array'
                            THEN environments -> 'testingUrls' ELSE '[]'::jsonb END)
              END,
              'live',
              jsonb_build_object('url', NULL, 'apiUrl', NULL, 'commitUrl', NULL, 'commitPath', NULL),
              'limits',
              CASE WHEN jsonb_typeof(environments -> 'notes') = 'string'
                   THEN environments -> 'notes' ELSE 'null'::jsonb END)
       )
 WHERE environments IS NOT NULL
   AND jsonb_typeof(environments) IS DISTINCT FROM 'null';
