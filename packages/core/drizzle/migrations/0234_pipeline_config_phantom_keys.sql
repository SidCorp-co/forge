-- ISS-994 — remove the keys in a stored `pipelineConfig` that no code reads.
--
-- Two sets, both phantoms an operator can read and reasonably act on:
--
--   recoveryMaxAttempts / recoveryWindowHours / recoveryByFailureKind
--     Configured the sweeper's multi-tier recovery against `issues.recovery_attempts`.
--     Commit 30ea219c (2026-05-16) deleted that surface, its three columns (migration
--     0059) and the schema keys in one change, replacing the bound with the one in
--     `jobs/retry.ts` (RETRY_TRIES_PER_DEVICE, RETRY_MAX_ROUNDS). Nothing has read
--     these since. `forge_config` action=get returns the stored document RAW, so
--     until this runs an operator reads `recoveryMaxAttempts: 3` and believes a
--     bound lives there.
--
--   states.<any status but `open`>.mode
--     `isEntryGateClosed` is the only consumer of `mode` and reads `states.open`.
--     Elsewhere it parsed, persisted and was reported by
--     `forge_skills.list_registrations` while gating nothing.
--
-- Deletion only, and only of keys with no reader — nothing here is data a reader
-- would want back. Every other key of every document is untouched, `open.mode`
-- included: it is the one representable way to close the entry gate, because
-- `pipeline-config-service.ts` refuses `open.enabled = false` outright.

DO $$
DECLARE
  with_recovery bigint;
  with_stage_mode bigint;
  changed bigint;
BEGIN
  SELECT count(*) INTO with_recovery
  FROM projects
  WHERE agent_config -> 'pipelineConfig' ?| ARRAY[
    'recoveryMaxAttempts', 'recoveryWindowHours', 'recoveryByFailureKind'
  ];

  SELECT count(*) INTO with_stage_mode
  FROM projects
  WHERE agent_config -> 'pipelineConfig' -> 'states' -> 'in_progress' ? 'mode'
     OR agent_config -> 'pipelineConfig' -> 'states' -> 'needs_info' ? 'mode'
     OR agent_config -> 'pipelineConfig' -> 'states' -> 'awaiting_release' ? 'mode';

  UPDATE projects
  SET agent_config =
    agent_config
      #- '{pipelineConfig,recoveryMaxAttempts}'
      #- '{pipelineConfig,recoveryWindowHours}'
      #- '{pipelineConfig,recoveryByFailureKind}'
      #- '{pipelineConfig,states,in_progress,mode}'
      #- '{pipelineConfig,states,needs_info,mode}'
      #- '{pipelineConfig,states,awaiting_release,mode}'
  WHERE agent_config ? 'pipelineConfig';

  GET DIAGNOSTICS changed = ROW_COUNT;

  RAISE NOTICE
    'ISS-994: rewrote % project pipelineConfig document(s); % carried a recovery key, % carried a non-entry states mode',
    changed, with_recovery, with_stage_mode;
END $$;
