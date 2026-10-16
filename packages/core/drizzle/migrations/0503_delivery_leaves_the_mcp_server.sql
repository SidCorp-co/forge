-- Delivery leaves core's MCP server. forge_source, forge_coolify_deploy, forge_sentry and
-- forge_storefront_target are served over REST under /api/projects/:id/integrations/… instead, and
-- the forge CLI calls those routes.
--
-- A project policy may deny one of them to a permission profile (`mcp__forge__forge_coolify_deploy`).
-- That entry is a decision — this profile does not deploy — and once the tool is gone it denies
-- nothing while the same act stays open over REST. The policy rules would also refuse every later
-- write of that policy, and of the project document beside it, for naming a tool nobody serves. So
-- this migration writes nothing and refuses to apply while any policy holds such an entry, naming
-- the project, the profile and the entry: a person decides what that profile may do now, rewrites
-- the policy, and the deploy is run again.
--
-- ROLLBACK: nothing to undo; it writes nothing.

DO $$
DECLARE
  hit record;
BEGIN
  SELECT p."project_id", prof.key AS profile, entry AS denied
    INTO hit
    FROM "project_policies" p,
         jsonb_each(p."document" -> 'permissions') AS prof,
         jsonb_array_elements_text(prof.value -> 'deny') AS entry
   WHERE entry IN (
     'mcp__forge__forge_source',
     'mcp__forge__forge_coolify_deploy',
     'mcp__forge__forge_sentry',
     'mcp__forge__forge_storefront_target'
   )
   ORDER BY p."project_id", prof.key
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'POLICY_DENIES_RETIRED_TOOL: project % policy profile % denies %, a delivery tool the MCP server no longer serves; it is served over REST under /api/projects/:id/integrations now. Decide what the profile may do, rewrite its deny list, then deploy again', hit."project_id", hit.profile, hit.denied USING ERRCODE = 'check_violation';
  END IF;
END $$;
