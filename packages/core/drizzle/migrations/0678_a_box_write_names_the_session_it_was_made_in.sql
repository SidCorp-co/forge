-- ISS-1251 (criterion 3). One box credential serves its master and the runs it starts, so a REST
-- write made on it counted under the credential (`checkout`, `box`) and never under the agent kind
-- that made it. The session it was made in is now kept beside the act, told apart the way a box's
-- reads already are (`run-context-ports.ts:runOfCall`): the run the call names (`x-forge-run`), a
-- session's own turn token, else the box's one live session in the project.
--   1. mcp_audit_log.agent_session_id: that session; null where none could be named (a box running
--      several sessions and the call naming none), for every call not made on a box credential, and
--      for every row written before this.
-- No existing row's value changes; the column is additive and references nothing, so a session's
-- removal never touches the audit log.
--
-- ROLLBACK (nothing references the column):
--   ALTER TABLE "mcp_audit_log" DROP COLUMN IF EXISTS "agent_session_id";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "mcp_audit_log" ADD COLUMN IF NOT EXISTS "agent_session_id" uuid;
