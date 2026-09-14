-- ISS-1007 — the Rocket.Chat persona stopped hardcoding a reply language, so the projects that were
-- relying on it keep it as their own setting instead of losing it.
--
-- WHO: exactly the projects a Rocket.Chat turn can reach. `buildRoutes` in
-- integrations/rocketchat/routes.ts keeps a binding only when it is active and its config.rids names
-- at least one room, and it is built per connection, so a project no active connection routes to has
-- never received one of these replies and is left alone.
--
-- HOW: prepended, never replacing. A project that already had a personaStyle was getting BOTH that
-- text and the persona's language line; dropping either half would be a change nobody asked for.
--
-- IDEMPOTENT: a style already carrying the sentence is skipped, so a re-run writes nothing. That is
-- also why no down migration exists — after this runs, nothing in the text distinguishes a sentence
-- this statement inserted from one a person had written, and a down matching on the text would
-- delete somebody's own words. The way back is the code revert, which puts the sentence back in the
-- persona and leaves this one a harmless repeat.
UPDATE projects p
SET agent_config = jsonb_set(
      coalesce(p.agent_config, '{}'::jsonb),
      '{personaStyle}',
      to_jsonb(
        CASE
          WHEN coalesce(btrim(p.agent_config ->> 'personaStyle'), '') = ''
            THEN 'Reply in Vietnamese (switch language only if the user clearly writes another one).'
          ELSE 'Reply in Vietnamese (switch language only if the user clearly writes another one).'
               || E'\n'
               || (p.agent_config ->> 'personaStyle')
        END
      )
    ),
    updated_at = now()
WHERE position(
        'Reply in Vietnamese (switch language only if the user clearly writes another one).'
        IN coalesce(p.agent_config ->> 'personaStyle', '')
      ) = 0
  AND EXISTS (
    SELECT 1
    FROM integration_bindings b
    JOIN integration_connections c ON c.id = b.connection_id
    WHERE b.project_id = p.id
      AND b.provider = 'rocketchat'
      AND b.active
      AND c.active
      AND jsonb_typeof(b.config -> 'rids') = 'array'
      AND jsonb_array_length(b.config -> 'rids') > 0
  );
