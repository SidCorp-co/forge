-- PR-5 — Speed up `findPriorSessionInGroup` and `invalidatePriorSessions`
-- queries that filter agent_sessions by (metadata->>'issueId',
-- metadata->>'sessionGroup'). Without this, every session-group dispatch
-- does a Seq Scan of agent_sessions; at fleet scale (100k+ rows) that
-- becomes the dispatcher's tail latency.
--
-- Functional indices are cheaper than a full GIN on metadata because the
-- lookup is always equality on these two specific paths. Filter restricts
-- to rows the resume path actually queries (completed status + claude
-- session id present) — keeps the index small.
--
-- Locking trade-off: standard `CREATE INDEX` takes ACCESS EXCLUSIVE on
-- agent_sessions for the duration of the build. Drizzle's migration runner
-- wraps each file in a transaction, so `CONCURRENTLY` is not an option
-- here. For deployments where agent_sessions already has >100k rows, run
-- this migration during a maintenance window OR drop these statements,
-- run the migration, then create the indices manually with:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_sessions_resume_lookup_idx
--     ON agent_sessions ((metadata->>'issueId'), (metadata->>'sessionGroup'))
--     WHERE status = 'completed' AND claude_session_id IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_sessions_invalidate_lookup_idx
--     ON agent_sessions ((metadata->>'issueId'), (metadata->>'sessionGroup'))
--     WHERE claude_session_id IS NOT NULL;
--
-- Reversible: DROP INDEX, no data migration.

CREATE INDEX IF NOT EXISTS "agent_sessions_resume_lookup_idx"
ON "agent_sessions" (
  (metadata->>'issueId'),
  (metadata->>'sessionGroup')
)
WHERE status = 'completed' AND claude_session_id IS NOT NULL;

-- Companion index for handle-resume-failed.ts invalidatePriorSessions:
-- same key shape but without the status filter (it scans any row whose
-- claudeSessionId is still set, including failed sessions whose claude
-- file may still exist on disk).
CREATE INDEX IF NOT EXISTS "agent_sessions_invalidate_lookup_idx"
ON "agent_sessions" (
  (metadata->>'issueId'),
  (metadata->>'sessionGroup')
)
WHERE claude_session_id IS NOT NULL;
