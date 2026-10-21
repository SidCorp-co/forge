-- ISS-1421 r22 — the dispatcher's ruling on judge-91's finding: deleting an organization deletes its
-- connections since round 21, but 82 on beta belong to organizations deleted before it. No person can
-- reach them (every listing resolves an organization the person is a member of), and each still holds
-- whatever key it was given.
--
-- Every connection an organization owns that no longer exists is deleted. Its bindings and its
-- Rocket.Chat rows go with it by their own cascades. A connection a person owns is not touched.
--
-- Destructive: a revert does not bring the rows back. Each belonged to an organization that is gone.
DO $$
DECLARE
  gone integer;
BEGIN
  DELETE FROM integration_connections c
   WHERE c.owner_type = 'org'
     AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.owner_id);
  GET DIAGNOSTICS gone = ROW_COUNT;
  RAISE NOTICE 'connections of organizations that no longer exist, deleted: %', gone;
END $$;
