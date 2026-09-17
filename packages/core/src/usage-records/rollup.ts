/**
 * Shared usage_records rollup pieces. `usage_records.session_id` is an
 * `agent_sessions.id` held in a TEXT column, constrained since ISS-1015 to
 * null or a canonical lowercase uuid, so every session-scoped rollup reaches
 * it by plain text equality and is served by `usage_records_session_id_idx`.
 * These helpers were previously copy-pasted across agent-sessions (/:id/cost,
 * list-cost rollup) and issues (/:id/cost-summary).
 */

import { type SQL, sql } from 'drizzle-orm';
import { usageRecords } from '../db/schema.js';

/**
 * A session id in the domain `usage_records.session_id` is stored in:
 * canonical lowercase uuid text. `::uuid` refuses anything that is not a uuid
 * and `::text` renders it lowercase, and Postgres folds the pair on a constant
 * at planning time, so what reaches the index is a text literal.
 *
 * Use it on a value that arrives as text — a route parameter, a page of ids.
 * A value already held in a `uuid` COLUMN is canonical by that type's own
 * definition and needs `::text` alone.
 */
export function canonicalSessionId(value: unknown): SQL {
  return sql`${value}::uuid::text`;
}

/**
 * Session match against the indexed column. `target` is the right-hand side of
 * a text comparison and has to be canonical already — `canonicalSessionId(v)`
 * for a text value, `sql`${uuidColumn}::text`` for a uuid column. Casting the
 * LEFT side instead is what made this predicate unable to use the index
 * (ISS-1015); casting neither is what makes an uppercase spelling silently
 * match nothing.
 *
 * e.g. sql`= ${canonicalSessionId(id)}`, sql`IN ${subqueryOfText}`.
 */
// cm:guard `target` must also be a reference Postgres can resolve UNAMBIGUOUSLY, and a field of a drizzle subquery is only that when it is a real column: drizzle renders those qualified (`"issue_sessions"."agent_session_id"`) and renders an `sql`…`.as(alias)` field as the BARE alias. `usage_records` has a `session_id` column, so a subquery field aliased `session_id` emitted `"usage_records"."session_id" = "session_id"`, which Postgres refuses at PARSE time — the Issues list answered 500 on every non-empty project until ISS-1081. Nothing in this signature stops it: `SQL` accepts both spellings and the wrong one reads exactly like `sql`= ${agentSessions.id}::text`` two callers away. Pass the column and cast on this side; never an aliased expression, whatever it is aliased to.
export function usageSessionMatch(target: SQL): SQL {
  return sql`${usageRecords.sessionId} ${target}`;
}

/** Selection map for the full cost/token totals rollup. Fresh object per
 *  call — drizzle projections should not be shared across queries. */
export function usageTotalsSelection() {
  return {
    estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
    inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
    outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
    cacheReadTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`.mapWith(Number),
    cacheCreationTokens: sql<number>`coalesce(sum(${usageRecords.cacheCreationTokens}), 0)`.mapWith(
      Number,
    ),
    requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
    sampleCount: sql<number>`count(${usageRecords.id})`.mapWith(Number),
  };
}

/** Zero-valued totals for the no-rows case (`...(totals ?? EMPTY_USAGE_TOTALS)`). */
export const EMPTY_USAGE_TOTALS = {
  estimatedCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  requests: 0,
  sampleCount: 0,
} as const;
