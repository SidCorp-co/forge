-- ISS-1311 — the way back from 0312, and what it cannot put back.
--
-- `db/migrate.ts` NEVER reads this folder. Nothing runs this for you: it is run
-- by hand, against a database whose container has already been rolled back to an
-- image that reads the three columns.
--
-- IT IS A LOSSY INVERSE, and the loss is named rather than papered over:
--
--   * `release_model`, `release_strategy` and — for a chain of two or more —
--     `live_branch` come back exactly, because the chain carries all three.
--   * `live_branch` on a project whose chain is shorter than two entries comes
--     back NULL. 0312 never read that value (ADR 0003: the chain is never
--     derived from `live_branch`), so it is not stored anywhere to restore from.
--     No code path read it either — `readableLiveBranch` answered null for
--     exactly those projects — which is why ADR 0003 accepts the loss by name.
--   * A chain of THREE OR MORE aborts this file rather than being truncated.
--     The three columns can hold two branches and no more, and dropping the
--     middle of somebody's release path to make it fit is the silent
--     substitution this repository refuses.
--
-- `base_branch` is untouched here as it was in 0312: it is the branch work is
-- cut from, not a release fact.

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s, %s branches)', id, slug, jsonb_array_length(release_chain)),
                    ', ' ORDER BY slug)
    INTO bad
    FROM projects WHERE jsonb_array_length(release_chain) > 2;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1311 rollback: % project(s) carry a release chain longer than two '
      'branches, which release_model/base_branch/live_branch/release_strategy cannot hold: %. '
      'Going back would have to drop a branch out of the middle of each release path. Shorten '
      'each chain above to at most two entries FIRST, deliberately, and then run this file.',
      (SELECT count(*) FROM projects WHERE jsonb_array_length(release_chain) > 2), bad;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_release_chain_chk";--> statement-breakpoint
DROP FUNCTION IF EXISTS projects_release_chain_ok(jsonb);--> statement-breakpoint

ALTER TABLE "projects" ADD COLUMN "release_model" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "live_branch" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "release_strategy" text;--> statement-breakpoint

UPDATE projects SET
  release_model = CASE jsonb_array_length(release_chain)
                    WHEN 0 THEN 'none'
                    WHEN 1 THEN 'publish'
                    ELSE 'promote' END,
  live_branch = CASE WHEN jsonb_array_length(release_chain) > 1
                     THEN release_chain -> 1 ->> 'branch' END,
  release_strategy = CASE WHEN jsonb_array_length(release_chain) > 1
                          THEN release_chain -> 1 ->> 'from' END;--> statement-breakpoint

ALTER TABLE "projects" ALTER COLUMN "release_model" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "release_model" SET DEFAULT 'none';--> statement-breakpoint

ALTER TABLE "projects" ADD CONSTRAINT "projects_release_model_chk"
  CHECK (release_model IN ('none', 'promote', 'publish'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_live_branch_chk"
  CHECK (release_model <> 'promote' OR live_branch IS NOT NULL);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_release_strategy_chk"
  CHECK ((release_model = 'promote') = (release_strategy IS NOT NULL)
         AND (release_strategy IS NULL
              OR release_strategy IN ('merge-branch', 'cherry-pick', 'tag-mr')));--> statement-breakpoint

ALTER TABLE "projects" DROP COLUMN "release_chain";
