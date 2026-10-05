-- The token grant for agent reports was stored under the word `feedback` (`feedback:read`,
-- `feedback:write`), which a token-settings reader takes for product feedback FB-n. The grant
-- resource is renamed `agent-reports` in credentials/pat-permissions.ts, and every stored grant is
-- rewritten to it here, so an issued token keeps exactly the reach it was given.
--
-- ROLLBACK: rewrite `agent-reports:read` / `agent-reports:write` back to `feedback:read` /
-- `feedback:write` in personal_access_tokens.permissions, with the code that names them.
--
-- A stored grant under the `feedback` resource other than read or write aborts this migration
-- naming it: the menu never offered one, and once the word is gone it would grant nothing in silence.
-- `feedback.approve` is an explicit permission, not a grant resource, and is left as it is.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE "personal_access_tokens" IN ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE bad text;
BEGIN
  SELECT g INTO bad FROM personal_access_tokens, unnest(permissions) g
  WHERE g LIKE 'feedback:%' AND g NOT IN ('feedback:read', 'feedback:write') LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PAT_GRANT_UNMAPPED: personal_access_tokens.permissions holds %; only feedback:read and feedback:write map to agent-reports:*, so this migration writes nothing until it is repaired', bad USING ERRCODE = 'check_violation';
  END IF;
END $$;--> statement-breakpoint
UPDATE "personal_access_tokens"
SET "permissions" = array_replace(array_replace("permissions", 'feedback:read', 'agent-reports:read'), 'feedback:write', 'agent-reports:write')
WHERE "permissions" && ARRAY['feedback:read', 'feedback:write']::text[];
