-- A release its agent recorded reads `recorded` (ISS-851, owner ruling 2026-11-01,
-- `release-is-the-agents-record`): the agent's record under its version IS the release, a normal and
-- complete state. Until now such a run stored verification `unverified`, its ledger verdict
-- `unverified`, and its readings ended "Forge read no deploy". Every such row is renamed in place;
-- the ledger's verdict check takes `recorded` instead of `unverified`. A release run whose stored
-- verification is none this migration knows aborts it, naming the row: nothing is guessed.
--
-- ROLLBACK: rename `recorded` back to `unverified` in the same three places and restore the check.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE
  bad record;
BEGIN
  SELECT id, metadata ->> 'verification' AS v INTO bad
    FROM pipeline_runs
   WHERE metadata ? 'verification'
     AND (jsonb_typeof(metadata -> 'verification') <> 'string'
          OR metadata ->> 'verification' NOT IN
             ('probed', 'deployment', 'provider', 'unverified', 'recorded', 'landed', 'merged'))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'pipeline run % stores verification %, which no release state represents: correct it before this migration renames unverified to recorded', bad.id, coalesce(bad.v, 'of another type');
  END IF;
  SELECT id, metadata -> 'finish' ->> 'verification' AS v INTO bad
    FROM pipeline_runs
   WHERE jsonb_typeof(metadata -> 'finish') = 'object'
     AND metadata -> 'finish' ? 'verification'
     AND jsonb_typeof(metadata -> 'finish' -> 'verification') <> 'null'
     AND (jsonb_typeof(metadata -> 'finish' -> 'verification') <> 'string'
          OR metadata -> 'finish' ->> 'verification' NOT IN
             ('probed', 'deployment', 'provider', 'unverified', 'recorded', 'landed'))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'pipeline run % stores finish verification %, which no release state represents: correct it before this migration renames unverified to recorded', bad.id, coalesce(bad.v, 'of another type');
  END IF;
END $$;--> statement-breakpoint
UPDATE pipeline_runs
   SET metadata = jsonb_set(metadata, '{verification}', '"recorded"')
 WHERE metadata ->> 'verification' = 'unverified';--> statement-breakpoint
UPDATE pipeline_runs
   SET metadata = jsonb_set(metadata, '{finish,verification}', '"recorded"')
 WHERE jsonb_typeof(metadata -> 'finish') = 'object'
   AND metadata -> 'finish' ->> 'verification' = 'unverified';--> statement-breakpoint
ALTER TABLE "release_attempts" DROP CONSTRAINT IF EXISTS "release_attempts_verdict_chk";--> statement-breakpoint
UPDATE release_attempts
   SET verdict = 'recorded',
       verdict_reason = regexp_replace(verdict_reason, '; Forge reads no commit and checked no deploy$', ''),
       readings = CASE
         WHEN jsonb_typeof(readings) = 'array' THEN coalesce(
           (SELECT jsonb_agg(replace(e.value, '; Forge read no deploy', '') ORDER BY e.n)
              FROM jsonb_array_elements_text(readings) WITH ORDINALITY AS e(value, n)),
           '[]'::jsonb)
         ELSE readings
       END
 WHERE verdict = 'unverified';--> statement-breakpoint
ALTER TABLE "release_attempts" ADD CONSTRAINT "release_attempts_verdict_chk"
  CHECK ("verdict" IS NULL OR "verdict" IN ('ok', 'failed', 'recorded'));
