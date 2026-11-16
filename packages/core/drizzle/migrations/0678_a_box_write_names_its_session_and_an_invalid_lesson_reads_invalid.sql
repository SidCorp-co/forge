-- ISS-1251 (criteria 3 and 9).
--   1. One box credential serves its master and the runs it starts, so a REST write made on it
--      counted under the credential (`checkout`, `box`), never the agent kind that made it. The
--      session it was made in is now kept beside the act, named as a box's reads already are
--      (`run-context-ports.ts:runOfCall`): the run the call names (`x-forge-run`), a session's own
--      turn token, else the box's one live session in the project.
--      mcp_audit_log.agent_session_id: that session; null where none could be named (a box running
--      several sessions and the call naming none), for every call not made on a box credential, and
--      for every row written before this.
--   2. A lesson a landing invalidated reads, by its slug, as invalid: its knowledge entry is
--      `deprecated` and its metadata names when and what touched it (`invalid`, `invalidAt`,
--      `invalidBy`), as `lessons/decide.ts:invalidateLessonIn` now writes it. The lessons held invalid
--      before this read `verified`; each is marked from its own lesson row. Re-admitting a lesson
--      publishes its entry again, which clears the mark.
-- The audit column is additive and references nothing, so a session's removal never touches the
-- audit log; no audit row's value changes. Only the entries of lessons held invalid change.
--
-- ROLLBACK (nothing references the column; the entries read verified again, as before):
--   ALTER TABLE "mcp_audit_log" DROP COLUMN IF EXISTS "agent_session_id";
--   UPDATE "knowledge_entries" SET "confidence" = 'verified',
--     "metadata" = "metadata" - 'invalid' - 'invalidAt' - 'invalidBy'
--     WHERE "kind" = 'lesson' AND "metadata" ? 'invalid';

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "mcp_audit_log" ADD COLUMN IF NOT EXISTS "agent_session_id" uuid;--> statement-breakpoint
UPDATE "knowledge_entries" k
   SET "confidence" = 'deprecated',
       "injection" = 'none',
       "metadata" = COALESCE(k."metadata", '{}'::jsonb) || jsonb_build_object(
         'invalid', true,
         'invalidAt', to_char(l."invalid_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'invalidBy', l."invalid_by"),
       "updated_at" = now()
  FROM "lessons" l
 WHERE k."project_id" = l."project_id"
   AND k."slug" = 'lesson-' || l."number"
   AND k."kind" = 'lesson'
   AND l."status" = 'held'
   AND l."invalid_at" IS NOT NULL
   AND NOT (k."metadata" ? 'invalid');
