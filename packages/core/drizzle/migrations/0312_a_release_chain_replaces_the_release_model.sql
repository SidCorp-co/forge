-- ISS-1311 / ADR 0003 — one fact spelled three ways becomes one ordered chain.
--
-- `release_model` ('none' | 'promote' | 'publish'), `live_branch` and
-- `release_strategy` ('merge-branch' | 'cherry-pick' | 'tag-mr') all answered
-- one question: what ordered path does this project's code take to live. Two
-- CHECK constraints existed only to stop the three contradicting each other.
--
-- After this migration:
--   projects.release_chain  jsonb  [] | [{branch}] | [{branch},{branch,from}] …
--                           first entry = where work merges, last = live,
--                           `from` = how the release crosses INTO that entry.
--
-- `base_branch` IS NOT TOUCHED. It is where an ISS-* branch is cut from, read by
-- `branches/resolve.ts:resolveIssueBranches`, and 28 of the 37 projects measured
-- on 2026-09-27 declare no release at all while carrying one. ADR 0003 maps
-- `none` to an empty chain, which names no branch; folding the column in would
-- have left those 28 projects with nowhere to cut work from, in silence.
--
-- DERIVED, NEVER DECLARED — and that is the opposite of 0253 on purpose. 0253
-- transcribed a measured fleet because `environment` meant three things and only
-- an owner knew which. Here the mapping is total and mechanical: ADR 0003's own
-- table, read off `release_model` and NEVER off the branch names. 25 of 32
-- projects carry a `live_branch` nothing promotes to, so deriving the chain from
-- the branch pair would move them onto a two-step release nobody asked for.
--
-- THE ONE ROW THIS SCHEMA CANNOT HOLD ABORTS BY NAME. `tag-mr` is removed rather
-- than rewritten: it had no behaviour, no document and no adopter, and mapping it
-- to `merge-branch` would change how a project releases on the strength of a
-- value nobody ever gave a meaning. No stored row carries it (measured), so this
-- refusal should never fire; `release-chain-migration-e2e.test.ts` plants one and
-- watches it fire anyway.
--
-- WHAT IS LOST, said here because running this backwards does not put it back:
-- the `live_branch` string on every project whose chain ends up shorter than two
-- entries. No code path reads it — every reader went through `readableLiveBranch`,
-- which answered null for exactly those projects — and ADR 0003 names and accepts
-- that loss under *The migration is total, and does not read `live_branch`*.

-- === 1. the column, defaulting to "this project ships nothing" ==============
ALTER TABLE "projects" ADD COLUMN "release_chain" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- === 2. the rows this schema cannot represent, refused by name ==============
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s)', id, slug), ', ' ORDER BY slug) INTO bad
    FROM projects WHERE release_strategy = 'tag-mr';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1311: % project(s) carry release_strategy ''tag-mr'', which this schema '
      'cannot represent: %. `tag-mr` is removed by ADR 0003 — it had no behaviour, no document '
      'and no adopter, so rewriting it to ''merge-branch'' would change how these projects '
      'release on the strength of a value nobody gave a meaning. Decide what each of them '
      'actually does, set release_strategy to ''merge-branch'' or ''cherry-pick'' accordingly, '
      'and redeploy. Do NOT default them.',
      (SELECT count(*) FROM projects WHERE release_strategy = 'tag-mr'), bad;
  END IF;
END $$;--> statement-breakpoint

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s, release_model %s)', id, slug, release_model), ', ' ORDER BY slug)
    INTO bad
    FROM projects WHERE release_model <> 'none' AND base_branch IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1311: % project(s) declare a release and name no base_branch: %. '
      'A release chain begins at the branch work merges into, so a releasing project with no '
      'base branch has no first entry and this schema cannot hold it. ADR 0003 maps `publish` '
      'with base B to [{branch: B}] and `promote` to [{branch: B},{branch: L, from: S}]; there '
      'is no B here to write. Set base_branch on each project above, or set its release_model '
      'to ''none'', and redeploy. Do NOT default it to ''main''.',
      (SELECT count(*) FROM projects WHERE release_model <> 'none' AND base_branch IS NULL), bad;
  END IF;
END $$;--> statement-breakpoint

-- === 3. the backfill — ADR 0003's table, read off release_model =============
UPDATE projects SET release_chain =
  CASE release_model
    WHEN 'none' THEN '[]'::jsonb
    WHEN 'publish' THEN jsonb_build_array(jsonb_build_object('branch', base_branch))
    WHEN 'promote' THEN jsonb_build_array(
      jsonb_build_object('branch', base_branch),
      jsonb_build_object('branch', live_branch, 'from', release_strategy))
  END;--> statement-breakpoint

-- A row the CASE did not reach would have been left at the '[]' default, which
-- reads as a deliberate "ships nothing" and is the silent shape this migration
-- exists to stop. `release_model` is NOT NULL and CHECKed to three values, so
-- this cannot fire; it is here because a default taken in silence is exactly
-- what a project would discover at its next release and not before.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s, release_model %s)', id, slug, release_model), ', ' ORDER BY slug)
    INTO bad
    FROM projects WHERE release_chain IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1311: % project(s) came out of the backfill with no chain: %. '
      'The CASE over release_model did not reach them, so their release shape would have been '
      'read as "ships nothing". Add their release_model to the CASE in 0312 and redeploy.',
      (SELECT count(*) FROM projects WHERE release_chain IS NULL), bad;
  END IF;
END $$;--> statement-breakpoint

-- === 4. the old spelling, deleted rather than annotated =====================
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_release_model_chk";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_live_branch_chk";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_release_strategy_chk";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "release_model";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "live_branch";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "release_strategy";--> statement-breakpoint

-- === 5. the chain's shape, held in Postgres =================================
-- A CHECK may not contain a subquery or a set-returning call, and walking a
-- jsonb array needs one — so the predicate is an IMMUTABLE function the CHECK
-- calls. This is NOT the pair of constraints dropped above wearing a new name:
-- those kept two columns from contradicting each other, and this one says what
-- a single value may be.
--
-- Every `from` test reads KEY PRESENCE (`jsonb_exists`) and then the value's
-- TYPE. `(e.v -> 'from') IS NULL` would have been false for `"from": null`,
-- and `NULL NOT IN (...)` is NULL rather than true, so a later entry carrying
-- a json null crossing satisfied the whole predicate and stored a chain the
-- zod schema refuses.
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
$fn$;--> statement-breakpoint

ALTER TABLE "projects" ADD CONSTRAINT "projects_release_chain_chk"
  CHECK (projects_release_chain_ok(release_chain));
