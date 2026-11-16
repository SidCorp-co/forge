-- Debt 868356b3 (cleanup 40944c54). Since ISS-1246 every operations-room message, and every
-- message no binding names (a DM), looks its room's open owner asks up by
-- `support_actions.output ->> 'rid'` (`support/owner-answer.ts:openAsksQuery`), and no index covered
-- that expression: each such message read support_actions, the largest support table, end to end.
--
-- The index is keyed on the expression the query compares, written as Postgres normalises it, so the
-- planner matches it. Its predicate is `IS NOT NULL` rather than the ask's kind and tool: the query's
-- strict `=` implies it whatever value is bound, so a generic prepared plan can use it too, where a
-- predicate on the bound kind or tool could not be proven. Only the actions that name a room in their
-- output (an ask, an owed raise) are in it.
--
-- Like 0281's expression indexes it is not mirrored in db/schema-support.ts: drizzle has no DSL that
-- renders `((output ->> 'rid'))`, and a mirror would make `db:generate` emit a DROP for it.
--
-- ROLLBACK: DROP INDEX IF EXISTS "support_actions_output_rid_idx";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_actions_output_rid_idx"
  ON "support_actions" ((output ->> 'rid'))
  WHERE (output ->> 'rid') IS NOT NULL;
