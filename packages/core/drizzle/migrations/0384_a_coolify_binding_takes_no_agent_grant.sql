-- Who may use Coolify is the `deploys.run` permission on the project (ISS-179): the per-binding
-- agent access switch that only the MCP tool read is gone, and a binding write naming one is refused
-- AGENT_ACCESS_UNSUPPORTED. A Coolify binding stored at `all` would hand that refusal to any client
-- that writes back the binding it read, so the value no rule reads is set to the closed default.
UPDATE integration_bindings SET agent_access = 'none' WHERE provider = 'coolify' AND agent_access <> 'none';
