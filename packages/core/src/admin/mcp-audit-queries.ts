/**
 * Per-tool call counts over the whole of `mcp_audit_log` — the evidence rule 3
 * of the MCP deletion rule is written against.
 *
 * `docs/architecture/agent-surface.md` is the authority on what the numbers
 * license. This file owns only the shape of the question, and it is shaped to
 * be the exact query that page describes rather than a convenient
 * approximation of it: whole table, no date filter, spelling normalised, and
 * the registry joined ON TOP of the aggregate so a tool nothing has ever
 * called still comes back with zeros.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { REGISTERED_TOOLS } from '../mcp/registered-tools.js';

/** One tool's lifetime call counts, split by the credential that made the call. */
export interface McpToolCallCounts {
  /** The registry's canonical dotted name, or the raw normalised key when the
   *  name was called but is not registered. */
  tool: string;
  registered: boolean;
  deviceCalls: number;
  tokenCalls: number;
  /** Rows carrying neither — a caller species that is no longer minted. */
  unattributedCalls: number;
  /** Rows the dispatcher did not recognise. Non-zero on a REGISTERED tool means
   *  callers are reaching it under a spelling this server does not answer. */
  notFoundCalls: number;
  totalCalls: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface McpAuditToolsReport {
  generatedAt: string;
  /** The oldest row in the table, which is how a reader judges whether these
   *  counts are lifetime counts. See the guard below. */
  oldestRow: string | null;
  registeredCount: number;
  rows: McpToolCallCounts[];
}

// cm:guard `deviceCalls`, `tokenCalls` and `unattributedCalls` are three INDEPENDENT counts over the same rows, not a partition of `totalCalls`, and they must not be added or subtracted from each other. A row may carry both ids, and `user_id` is stamped `device.ownerId` for a device caller — which is why splitting on it reads 100% user and 0 device for every tool, the mistake `7f0c5a56` deleted six live tools on.
// cm:guard count the WHOLE table with no date filter, and normalise with `replace(tool,'.','_')` on BOTH sides — this column stores `request.params.name` verbatim and agents send the underscore form their MCP client shows them, so a query for the dotted name alone finds none of those rows.
// cm:guard FULL OUTER, never inner and never a plain LEFT from the log: a tool nothing has ever called has no row here at all (an inner join drops exactly the tools the deletion rule is hunting), and a name that was called but is NOT registered has no registry row (a LEFT from the registry drops the misspelling evidence). Both directions are findings.
// cm:edge contract -> docs/architecture/agent-surface.md — the deletion rule reads these fields by name; `oldestRow` exists because that page's "whole table means lifetime" clause holds only while `enforceMcpAuditRetention` is unwired, and a caller must be able to see that for itself rather than trust a claim in prose
export async function mcpToolCallCounts(): Promise<McpAuditToolsReport> {
  const rows = (await db.execute(sql`
    WITH agg AS (
      SELECT replace(tool, '.', '_') AS tool_key,
             count(*) FILTER (WHERE device_id IS NOT NULL)::int AS device_calls,
             count(*) FILTER (WHERE token_id IS NOT NULL)::int AS token_calls,
             count(*) FILTER (WHERE device_id IS NULL AND token_id IS NULL)::int
               AS unattributed_calls,
             count(*) FILTER (WHERE result_code = 'not_found')::int AS not_found_calls,
             count(*)::int AS total_calls,
             min(created_at) AS first_seen,
             max(created_at) AS last_seen
      FROM mcp_audit_log
      GROUP BY 1
    ),
    registry AS (
      SELECT t AS tool, replace(t, '.', '_') AS tool_key
      FROM unnest(${registryArray()}) AS t
    )
    SELECT COALESCE(registry.tool, agg.tool_key) AS tool,
           (registry.tool IS NOT NULL) AS registered,
           COALESCE(agg.device_calls, 0) AS device_calls,
           COALESCE(agg.token_calls, 0) AS token_calls,
           COALESCE(agg.unattributed_calls, 0) AS unattributed_calls,
           COALESCE(agg.not_found_calls, 0) AS not_found_calls,
           COALESCE(agg.total_calls, 0) AS total_calls,
           agg.first_seen,
           agg.last_seen
    FROM registry
    FULL OUTER JOIN agg ON agg.tool_key = registry.tool_key
    ORDER BY 2 DESC, 1 ASC
  `)) as unknown as Array<Record<string, unknown>>;

  const [oldest] = (await db.execute(sql`
    SELECT min(created_at) AS oldest FROM mcp_audit_log
  `)) as unknown as Array<{ oldest: unknown }>;

  return {
    generatedAt: new Date().toISOString(),
    oldestRow: iso(oldest?.oldest),
    registeredCount: REGISTERED_TOOLS.length,
    rows: rows.map(toCounts),
  };
}

// cm:why bound one element at a time into an `ARRAY[...]::text[]` rather than passed as a JS array: drizzle expands an array parameter into a parenthesised `($1, $2, …)` RECORD, and Postgres refuses `cannot cast type record to text[]`
function registryArray(): SQL {
  return sql`ARRAY[${sql.join(
    REGISTERED_TOOLS.map((t) => sql`${t}`),
    sql`, `,
  )}]::text[]`;
}

function iso(x: unknown): string | null {
  if (x === null || x === undefined) return null;
  return x instanceof Date ? x.toISOString() : new Date(x as string).toISOString();
}

function toCounts(r: Record<string, unknown>): McpToolCallCounts {
  return {
    tool: String(r.tool),
    registered: r.registered === true,
    deviceCalls: Number(r.device_calls ?? 0),
    tokenCalls: Number(r.token_calls ?? 0),
    unattributedCalls: Number(r.unattributed_calls ?? 0),
    notFoundCalls: Number(r.not_found_calls ?? 0),
    totalCalls: Number(r.total_calls ?? 0),
    firstSeen: iso(r.first_seen),
    lastSeen: iso(r.last_seen),
  };
}
