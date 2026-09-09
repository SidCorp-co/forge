-- `released` → `awaiting_release`. The rung is not renamed, the LIE is.
--
-- `released` is the past tense of an action that has not happened. It named the
-- place an issue waits for a person to trigger production, and every reader had
-- to know that "released" meant "not released". It was a trigger standing in for
-- an action, because the old lane had no release button: moving an issue to
-- `released` WAS how a release started. `releasing` (0227) plus the release
-- button replaced that, so the waiting rung can finally be called what it is.
--
-- The name is not new. `AUTONOMOUS_LABELS` has rendered this rung as
-- `awaiting_release` on the board since ISS-970; only the kernel status
-- disagreed. After this, label and status are the same word.
--
-- Four surfaces move together, and the third is the one that must not be missed:
--   1. 80 issue rows across 13 projects.
--   2. `states.released` on 29 project configs. `pipelineConfig.states` is a
--      `partialRecord(z.enum(STAGE_NAMES))`, and zod 4 REJECTS an unknown key
--      (`invalid_key`) rather than stripping it. A rejected config reads as
--      `cfg = null` in `pipeline/orchestrator.ts`, `isAutonomous` answers false,
--      and the pipeline stops for that project in silence — the same failure
--      `orchestrator.ts`' own header records from ISS-897. Renaming the enum
--      member without this UPDATE would stop 29 projects dispatching.
--   3. `poolBacklog.statuses` on 1 project, for the same reason.
--
-- History is left alone, on purpose: `comments.stage` (13 rows, no CHECK) and
-- `activity_log.payload->>'to'` (4,488 rows) record what the status was CALLED
-- when they were written. The SQL readers of those two accept both spellings.
-- `pipeline_runs.metadata->>'gateStatus'` and `jobs.payload->>'gateStatus'` (7
-- rows each, all terminal) are read by id, never by status match.
--
-- The status UPDATE is deliberately a rename and NOT a transition: no
-- `kernel_transitions` row, no `activity_log` entry, no dispatch, no dependent
-- unblocked. The issue has not moved; the rung it stands on has been renamed
-- under it.
--
-- Roll back: re-create the 0227 constraint, then reverse the three UPDATEs.
-- Every one of them is a pure string swap in both directions.

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_chk;--> statement-breakpoint
ALTER TABLE issues ADD CONSTRAINT issues_status_chk
  CHECK (status IN (
    'open','confirmed','clarified','waiting','approved','in_progress','developed',
    'deploying','testing','tested','pass','staging','released','awaiting_release',
    'releasing','closed','reopen','on_hold','needs_info','draft','dropped'
  ));--> statement-breakpoint

UPDATE issues SET status = 'awaiting_release' WHERE status = 'released';--> statement-breakpoint

UPDATE projects SET agent_config = jsonb_set(
    agent_config #- '{pipelineConfig,states,released}',
    '{pipelineConfig,states,awaiting_release}',
    agent_config #> '{pipelineConfig,states,released}'
  )
  WHERE (agent_config #> '{pipelineConfig,states}') ? 'released';--> statement-breakpoint

UPDATE projects SET agent_config = jsonb_set(
    agent_config,
    '{pipelineConfig,poolBacklog,statuses}',
    (
      SELECT jsonb_agg(
        CASE WHEN elem = '"released"'::jsonb THEN '"awaiting_release"'::jsonb ELSE elem END
      )
      FROM jsonb_array_elements(agent_config #> '{pipelineConfig,poolBacklog,statuses}') AS elem
    )
  )
  WHERE (agent_config #> '{pipelineConfig,poolBacklog,statuses}') @> '["released"]';--> statement-breakpoint

ALTER TABLE issues DROP CONSTRAINT issues_status_chk;--> statement-breakpoint
ALTER TABLE issues ADD CONSTRAINT issues_status_chk
  CHECK (status IN (
    'open','confirmed','clarified','waiting','approved','in_progress','developed',
    'deploying','testing','tested','pass','staging','awaiting_release',
    'releasing','closed','reopen','on_hold','needs_info','draft','dropped'
  ));
