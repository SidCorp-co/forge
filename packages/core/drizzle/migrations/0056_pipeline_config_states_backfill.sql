-- ISS-108 Phase 1 — backfill pipelineConfig.states for existing projects.
-- Seeds all 7 auto-stages as enabled + auto so existing projects retain
-- current behavior. Skips projects that already have a non-null
-- pipelineConfig.states (deliberate operator config wins).
-- Reversible: UPDATE projects SET agent_config = agent_config #- '{pipelineConfig,states}'
--             WHERE agent_config #> '{pipelineConfig,states}' IS NOT NULL;

UPDATE projects
SET agent_config = jsonb_set(
  COALESCE(agent_config, '{}'::jsonb),
  '{pipelineConfig,states}',
  '{
    "open":      {"enabled": true, "mode": "auto"},
    "confirmed": {"enabled": true, "mode": "auto"},
    "approved":  {"enabled": true, "mode": "auto"},
    "developed": {"enabled": true, "mode": "auto"},
    "testing":   {"enabled": true, "mode": "auto"},
    "reopen":    {"enabled": true, "mode": "auto"},
    "released":  {"enabled": true, "mode": "auto"}
  }'::jsonb,
  true
)
WHERE COALESCE(agent_config #> '{pipelineConfig,states}', 'null'::jsonb) = 'null'::jsonb;
