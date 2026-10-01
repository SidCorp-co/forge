-- The keys of `projects.agent_config` that S3c deleted with every reader, writer and door.
--
--   agentConfig.personaStyle, agentConfig.systemPrompt
--     Additions to the assistant's prompt. The assistant now answers from its channel persona and
--     the answering handle's own self, and neither key has a door left to write it.
--
--   agentConfig.rocketChatAnswerMode
--     Chose the runner-hosted `agent` lane for a Rocket.Chat turn. The lane is gone; every turn is
--     answered by the assistant and escalates through its escalate tool.
--
--   agentConfig.categories
--     Answered by `forge_config` and checked by nothing.
--
--   agentConfig.plugins[].autoUpdate
--     A designation now floats exactly when it names no `pinnedRef`. The plugin reader is strict,
--     so a stored entry still carrying the key would be refused by name on every device read; it is
--     removed here instead of being tolerated there.
--
-- DELETED, NOT MOVED. No project-v1 key carries any of them, so there is nowhere to move a value.
-- Every document this file changes is printed whole by RAISE NOTICE before anything is written,
-- the way 0285 did: the deploy log is the record, and replaying one is
-- `UPDATE projects SET agent_config = '<the logged document>'::jsonb WHERE id = '<id>'`.
--
-- A `plugins` value that is not a list is not a document any door wrote, so the deploy stops and
-- names the project rather than guessing what its entries were.
--
-- Data only: no CREATE, no ALTER, no DROP. A RAISE EXCEPTION rolls the whole file back.

DO $s3c$
DECLARE
  dropped_keys CONSTANT text[] := ARRAY[
    'personaStyle', 'systemPrompt', 'rocketChatAnswerMode', 'categories'
  ];
  shaped RECORD;
  doomed RECORD;
  changed_rows INT;
BEGIN
  FOR shaped IN
    SELECT p.slug AS slug, jsonb_typeof(p.agent_config -> 'plugins') AS kind
      FROM projects p
     WHERE jsonb_typeof(p.agent_config) = 'object'
       AND p.agent_config ? 'plugins'
       AND jsonb_typeof(p.agent_config -> 'plugins') <> 'array'
  LOOP
    RAISE EXCEPTION 'project % stores agent_config.plugins as a %, not a list: no door writes that, so this migration will not guess its entries', shaped.slug, shaped.kind;
  END LOOP;

  FOR doomed IN
    SELECT p.id AS id, p.slug AS slug, p.agent_config AS doc
      FROM projects p
     WHERE jsonb_typeof(p.agent_config) = 'object'
       AND (
         p.agent_config ?| dropped_keys
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
                    CASE WHEN p.agent_config ? 'plugins' THEN p.agent_config -> 'plugins'
                         ELSE '[]'::jsonb END
                  ) AS entry
            WHERE jsonb_typeof(entry) = 'object' AND entry ? 'autoUpdate'
         )
       )
  LOOP
    RAISE NOTICE 'S3c: project % (%) agent_config before: %', doomed.slug, doomed.id, doomed.doc;
  END LOOP;

  UPDATE projects p
     SET agent_config = (p.agent_config - dropped_keys)
           || CASE
                WHEN p.agent_config ? 'plugins' THEN jsonb_build_object(
                  'plugins',
                  COALESCE(
                    (SELECT jsonb_agg(
                              CASE WHEN jsonb_typeof(entry) = 'object' THEN entry - 'autoUpdate'
                                   ELSE entry END
                              ORDER BY ord)
                       FROM jsonb_array_elements(p.agent_config -> 'plugins')
                            WITH ORDINALITY AS e(entry, ord)),
                    '[]'::jsonb
                  )
                )
                ELSE '{}'::jsonb
              END
   WHERE jsonb_typeof(p.agent_config) = 'object'
     AND (
       p.agent_config ?| dropped_keys
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
                  CASE WHEN p.agent_config ? 'plugins' THEN p.agent_config -> 'plugins'
                       ELSE '[]'::jsonb END
                ) AS entry
          WHERE jsonb_typeof(entry) = 'object' AND entry ? 'autoUpdate'
       )
     );
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RAISE NOTICE 'S3c: % project(s) had a deleted agent_config key removed', changed_rows;
END
$s3c$;
