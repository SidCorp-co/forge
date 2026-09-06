-- ISS-873 phase 6 — strip `sessionMode` from every stored project config.
-- Hand-written data migration (applied from meta/_journal.json), same shape as
-- 0209_drop_staged_lane.
--
-- Invariant 6: this runs BEFORE the key leaves `pipeline-config-schema.ts`.
-- That object is `.strict()`, so a stored config still carrying `sessionMode`
-- after the key is deleted fails validation for the WHOLE project, not just the
-- key — every `PATCH /pipeline-config` and everything else that parses the
-- config with it.
--
-- Two halves, and the order between them is the whole point.
--
-- 1. A project that explicitly asked for `print` ABORTS THIS MIGRATION, naming
--    the projects. It is not cleaned away so the migration succeeds.
--
--    This is the case the phase 5 flip deliberately created: for one release
--    `sessionMode: 'print'` is the opt-OUT, the lever a project reaches for
--    when residency misbehaves on it. Stripping that key would move exactly the
--    project that said "not this lane" onto that lane, with nothing anywhere
--    recording that its answer was overridden — and it would present as a
--    project that had simply never opted out. An operator who is told
--    `project <slug> is opted out of duplex` loses ten minutes; one whose
--    opted-out project silently starts running resident sessions loses the
--    reason it opted out.
--
--    The way past it is a decision, never a rerun: either the project's
--    objection is resolved and a human clears its key, or phase 6 does not ship
--    yet. Measured on forge-beta 2026-09-06: zero projects set `print`
--    explicitly (3 set `duplex`, 27 have the key absent), so this half is
--    expected to pass today and exists for the window, not for now.
--
-- 2. Everything still carrying the key has it removed. For a `duplex` project
--    that is a pure no-op in effect — duplex is the only lane left — and for
--    the 27 with the key absent there is nothing to do at all.
--
-- `- 'sessionMode'` on the nested object rather than a `#-` path, so a config
-- with no `pipelineConfig` at all is untouched instead of gaining one.

DO $$
DECLARE
  opted_out text;
BEGIN
  SELECT string_agg(slug, ', ' ORDER BY slug)
    INTO opted_out
    FROM projects
   WHERE agent_config -> 'pipelineConfig' ->> 'sessionMode' = 'print';

  IF opted_out IS NOT NULL THEN
    RAISE EXCEPTION
      'ISS-873 phase 6 refuses to strip sessionMode: these projects are explicitly opted OUT of duplex and this migration would silently opt them back in: %. Resolve why each opted out and clear its key by hand, or do not ship phase 6 yet.',
      opted_out;
  END IF;
END $$;

UPDATE projects
   SET agent_config = jsonb_set(
         agent_config,
         '{pipelineConfig}',
         (agent_config -> 'pipelineConfig') - 'sessionMode'
       )
 WHERE agent_config -> 'pipelineConfig' ? 'sessionMode';
