-- Undo 0328_a_chain_can_name_the_tag_that_ships_it (ISS-1391).
--
-- `db/migrate.ts` NEVER reads this folder. Nothing runs this for you: it is run by hand, against a
-- database whose container has already been rolled back to an image that does not write `tag`.
--
-- The previous `projects_release_chain_ok` refuses a `tag` key. Putting it back while a project
-- still declares one would leave that row failing the CHECK on its next UPDATE, and deleting the
-- key from the row would change how that project releases in silence — so this ABORTS NAMING the
-- projects instead. Clear each one's tag first (`PATCH /api/projects/:id` with the `releaseChain`
-- minus `tag`) and run this again.

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s)', id, slug), ', ' ORDER BY slug) INTO bad
    FROM projects
   WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(release_chain) AS e(v) WHERE jsonb_exists(e.v, 'tag'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1391: project(s) still declare a release tag: %. The previous release-chain '
      'CHECK refuses the key, and dropping it would change how these projects release. Remove `tag` '
      'from each project''s releaseChain, then run this again.', bad;
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION projects_release_chain_ok(chain jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT chain IS NOT NULL
     AND jsonb_typeof(chain) = 'array'
     AND jsonb_array_length(chain) <= 8
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(chain) WITH ORDINALITY AS e(v, n)
        WHERE jsonb_typeof(e.v) IS DISTINCT FROM 'object'
           OR jsonb_typeof(e.v -> 'branch') IS DISTINCT FROM 'string'
           OR length(e.v ->> 'branch') = 0
           OR (e.n = 1) = jsonb_exists(e.v, 'from')
           OR (jsonb_exists(e.v, 'from')
               AND (jsonb_typeof(e.v -> 'from') IS DISTINCT FROM 'string'
                    OR (e.v ->> 'from') NOT IN ('merge-branch', 'cherry-pick')))
           OR EXISTS (
                SELECT 1 FROM jsonb_object_keys(e.v) AS k
                 WHERE k NOT IN ('branch', 'from'))
     )
     AND (SELECT count(DISTINCT v ->> 'branch') FROM jsonb_array_elements(chain) AS v)
       = jsonb_array_length(chain);
$fn$;
