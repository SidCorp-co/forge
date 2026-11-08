-- Two lookups every Needs you, attention and home read makes once per issue read one index entry
-- (ISS-1070 r10). Whether a closed issue still waits for a release asks its newest move into
-- `closed` (`issues/waiting-for-release.ts:closedUnreleasedSql`), which read every move of the issue
-- through `kernel_transitions_entity_idx` and sorted them, for each of forge's thousand closed issues;
-- and the forecast's start of work asks an issue's first move to `in_progress`
-- (`forecast/facts.ts:landedRows`, `readWork`), which read every activity row the issue holds. Each
-- partial index holds only the rows its lookup asks, in the order it takes them.
--
-- ROLLBACK: DROP INDEX IF EXISTS "kernel_transitions_issue_closed_idx"; DROP INDEX IF EXISTS "activity_log_issue_started_idx";
CREATE INDEX IF NOT EXISTS "kernel_transitions_issue_closed_idx" ON "kernel_transitions" USING btree ("entity_id", "created_at" DESC, "id" DESC) WHERE "entity" = 'issue' AND "to_status" = 'closed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_issue_started_idx" ON "activity_log" USING btree ("issue_id", "created_at") WHERE "action" = 'issue.statusChanged' AND ("payload" ->> 'to') = 'in_progress';
