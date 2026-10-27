-- A project's own agent account, its handle, holds `deploys.run` on its project
-- (`conversations/handles.ts:PROJECT_HANDLE_GRANTS`). The handle is who every pane a runner box
-- starts for the project acts as, through the checkout credential, and a release job is one of
-- those panes: the deploy it exists to run asks `deploys.run`, which a member holds only where the
-- project's grant names it. A handle minted as a plain member had every release job's deploy
-- refused (sidcorp-mail, 2026-10-27). Handles minted from now on carry the grant; this gives it to
-- each one minted before.
--
-- The handle is read as `conversations/handles.ts:existingProjectHandle` reads it: per project, the
-- oldest agent account that is a member of that project alone and is not its steward, and only
-- where it carries a handle on its org membership (one without is refused HANDLE_HAS_NO_NAME and
-- reaches no pane). A membership already naming the grant is left as it is.
--
-- ROLLBACK: array_remove(grants, 'deploys.run') on the same memberships. Which ones held it by hand
-- before this ran is not recorded, so a rollback takes those too.
WITH handle AS (
  SELECT DISTINCT ON (m.project_id) m.project_id, m.user_id
  FROM project_members m
  JOIN users u ON u.id = m.user_id
  WHERE u.kind = 'agent'
    AND NOT EXISTS (
      SELECT 1 FROM project_members other
      WHERE other.user_id = m.user_id AND other.project_id <> m.project_id
    )
    AND NOT EXISTS (SELECT 1 FROM steward_accounts s WHERE s.user_id = m.user_id)
  ORDER BY m.project_id, u.created_at, u.id
)
UPDATE project_members pm
SET grants = array_append(pm.grants, 'deploys.run')
FROM handle h
WHERE pm.project_id = h.project_id
  AND pm.user_id = h.user_id
  AND NOT ('deploys.run' = ANY (pm.grants))
  AND EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.user_id = h.user_id AND om.handle IS NOT NULL
  );
