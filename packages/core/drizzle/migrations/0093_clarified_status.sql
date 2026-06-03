-- Clarify on the happy path. Inserts the `clarified` status between
-- `confirmed` and `waiting`/`approved` and re-wires the clarify step from the
-- needs_info bounce path onto the happy path:
--   open ─triage→ confirmed ─clarify→ clarified ─plan→ waiting/approved
-- needs_info goes back to being a human-gated bounce state (no pipeline step).
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0087-0092 headers). The runtime migrator applies
-- this row from _journal.json.

-- 1. Status CHECK gains 'clarified' (defence-in-depth mirror of the Drizzle
--    TS enum, established by 0079).
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_chk;
ALTER TABLE issues ADD CONSTRAINT issues_status_chk
  CHECK (status IN (
    'open','confirmed','clarified','waiting','approved','in_progress','developed',
    'deploying','testing','tested','pass','staging','released',
    'closed','reopen','on_hold','needs_info','draft'
  ));

-- 2. Move skill registrations to the new stage layout. Order matters: the
--    plan rows vacate 'confirmed' BEFORE the clarify rows move into it, so
--    the (project_id, stage) unique index never collides.
UPDATE skill_registrations SET stage = 'clarified' WHERE stage = 'confirmed';
UPDATE skill_registrations SET stage = 'confirmed' WHERE stage = 'needs_info';

-- 3. Behavior-preserving backfill. After the rewire, the 'confirmed' stage
--    dispatches clarify gated by autoClarify. A project that never enabled
--    autoClarify would STALL at confirmed (toggle-off is a manual gate, not a
--    skip). Mark states.confirmed enabled=false for those projects so the
--    skip-chain auto-advances confirmed → clarified and their effective flow
--    (triage → plan) is unchanged. Projects opting into clarify later flip
--    autoClarify=true + states.confirmed.enabled=true.
UPDATE projects
SET agent_config = jsonb_set(
  jsonb_set(
    agent_config,
    '{pipelineConfig,states}',
    COALESCE(agent_config #> '{pipelineConfig,states}', '{}'::jsonb),
    true
  ),
  '{pipelineConfig,states,confirmed}',
  COALESCE(agent_config #> '{pipelineConfig,states,confirmed}', '{}'::jsonb)
    || '{"enabled": false}'::jsonb,
  true
)
WHERE jsonb_typeof(agent_config -> 'pipelineConfig') = 'object'
  AND NOT COALESCE(
    CASE
      WHEN jsonb_typeof(agent_config #> '{pipelineConfig,autoClarify}') = 'boolean'
        THEN (agent_config #>> '{pipelineConfig,autoClarify}')::boolean
      WHEN jsonb_typeof(agent_config #> '{pipelineConfig,autoClarify}') = 'object'
        THEN COALESCE(
          (agent_config #>> '{pipelineConfig,autoClarify,enabled}')::boolean,
          true
        )
      ELSE false
    END,
    false
  );
