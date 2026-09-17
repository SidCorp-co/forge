/**
 * ISS-1027 — the stated retention rule for every append-only table in this
 * schema, in one place.
 *
 * Every table here was added as an append-only record with the deletion
 * question deferred, and the deferral was invisible: a table with no rule and a
 * table whose rule is "keep it all" look identical from the outside. So each
 * one carries an entry, including the two that are never swept, and each entry
 * carries the reason it has the window it has.
 *
 * A window is policy rather than kernel state, so an operator moves it with an
 * environment variable and no redeploy. An override below the floor is not
 * absorbed: `resolveRetention` reports it and uses the floor, because a window
 * silently widened back up is the same defect as one silently narrowed down.
 */

/** One table's stated rule. */
export interface RetentionRule {
  /** The physical table this rule governs. */
  table: string;
  /** Days a row is kept, or null where this table is deliberately never swept. */
  days: number | null;
  /** The variable an operator moves `days` with, or null where there is no window. */
  env: string | null;
  /** The lowest window an override may set. Below it the override is rejected. */
  floorDays: number;
  /** Why this table has the rule it has, and what would change it. */
  why: string;
}

export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    table: 'job_events',
    days: 30,
    env: 'RETENTION_JOB_EVENTS_DAYS',
    floorDays: 7,
    why: 'The events a session transcript is derived from. They go only once that transcript is recorded as finalised, because the transcript is the record that survives and these rows are what rebuild it. A week is the shortest window an incident can still be reconstructed from.',
  },
  {
    table: 'queue_snapshots',
    days: 90,
    env: 'RETENTION_QUEUE_SNAPSHOTS_DAYS',
    floorDays: 90,
    why: 'Per-tick queue depth, read only by the `queue_depth` metric. `metrics/queries.ts` caps its own window at 90 days, so a shorter retention loses the tail of that chart with nothing going red — which is why the floor is the cap rather than something smaller.',
  },
  {
    table: 'runner_events',
    days: 90,
    env: 'RETENTION_RUNNER_EVENTS_DAYS',
    floorDays: 90,
    why: 'A runner status timeline, read by the activity panel and by the `runner_uptime` metric under the same 90-day cap. The newest row for a runner is never deleted whatever its age: `runner_uptime` reads it as the pre-window carry-in, and without it the leading edge of that chart is wrong rather than absent.',
  },
  {
    table: 'kernel_transitions',
    days: 90,
    env: 'RETENTION_KERNEL_TRANSITIONS_DAYS',
    floorDays: 30,
    why: 'The audit of every terminal kernel flip. A row is never deleted while the job, session or run it records is still non-terminal, whatever its age. A month is the shortest span over which this table still answers an incident question.',
  },
  {
    table: 'retrieval_analytics',
    days: 90,
    env: 'RETENTION_RETRIEVAL_ANALYTICS_DAYS',
    floorDays: 7,
    why: 'One row per memory search, read by `GET /api/admin/retrieval/breakdown`, which defaults to a 7-day window and takes an arbitrary `since`.',
  },
  // cm:guard NOT swept, and the reason is a live coupling rather than caution: `docs/architecture/agent-surface.md`'s MCP tool-deletion rule spends `count(*)` over the WHOLE table as evidence that a tool was never called, and `admin/mcp-audit-queries.ts` runs exactly that query with no date filter. A window here turns "zero rows, never called" into "zero rows in N days" and licenses deleting a quarterly-called tool with nothing going red. `drizzle/migrations/0063_mcp_audit_log.sql` declares 90 days in a comment and is superseded by this entry; ISS-1027 deleted the unwired `enforceMcpAuditRetention` that implemented it. What would end this: a durable per-tool lifetime aggregate that survives deletion, which needs a table of its own.
  {
    table: 'mcp_audit_log',
    days: null,
    env: null,
    floorDays: 0,
    why: 'Not swept. The MCP tool-deletion rule in docs/architecture/agent-surface.md reads a count over the whole table as a lifetime count, so a time window would silently license deleting a tool that is called quarterly. Ends when a per-tool lifetime aggregate exists that survives deletion.',
  },
  {
    table: 'agent_session_turns',
    days: null,
    env: null,
    floorDays: 0,
    why: 'Not swept, and not append-only in the sense this rule is about: it materialises `agent_sessions.messages` one row per turn, under an ON DELETE CASCADE from its parent session, so its lifetime is that session’s and a time window here would delete half a live transcript.',
  },
];

/** A rule with its environment override applied, and what that override cost. */
export interface ResolvedRetention {
  table: string;
  /** The window to sweep at, or null where this table is never swept. */
  days: number | null;
  /** Set when an override was read and not taken as it stood. */
  rejected: string | null;
}

export const FINALIZE_REPAIR_ENV = 'RETENTION_FINALIZE_REPAIR_MAX';
const FINALIZE_REPAIR_DEFAULT = 200;

type Env = Record<string, string | undefined>;

/**
 * The window this rule sweeps at once the environment has had its say.
 *
 * A rule with no window ignores the environment entirely — there is no variable
 * to set, and inventing one would let an operator switch on a sweep the entry
 * above explains why this repo does not have.
 */
export function resolveRetention(rule: RetentionRule, env: Env = process.env): ResolvedRetention {
  if (rule.days === null || rule.env === null) {
    return { table: rule.table, days: null, rejected: null };
  }
  const raw = env[rule.env];
  if (raw === undefined || raw.trim() === '') {
    return { table: rule.table, days: rule.days, rejected: null };
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return {
      table: rule.table,
      days: rule.days,
      rejected: `${rule.env}="${raw}" is not a whole number of days; using the stated ${rule.days}`,
    };
  }
  if (parsed < rule.floorDays) {
    return {
      table: rule.table,
      days: rule.floorDays,
      rejected: `${rule.env}=${parsed} is below this table's floor of ${rule.floorDays} days; using the floor`,
    };
  }
  return { table: rule.table, days: parsed, rejected: null };
}

/** Every rule resolved, in the order they are stated. */
export function resolveAllRetention(env: Env = process.env): ResolvedRetention[] {
  return RETENTION_RULES.map((rule) => resolveRetention(rule, env));
}

/** The rule for one table, or undefined where this schema states none. */
export function retentionRuleFor(table: string): RetentionRule | undefined {
  return RETENTION_RULES.find((rule) => rule.table === table);
}

/**
 * The window one table sweeps at right now, for a surface that has to render it.
 *
 * `null` means this table has no time window, which is a stated rule and not an
 * absence. A table with no entry at all is a different thing and throws by name:
 * a caller asking about a table this schema states nothing for has a bug, and
 * answering `null` would dress it as a policy decision.
 */
export function resolvedWindowDaysFor(table: string, env: Env = process.env): number | null {
  const rule = retentionRuleFor(table);
  if (!rule) {
    throw new Error(
      `retention: no rule is stated for "${table}". Every append-only table takes an entry in RETENTION_RULES, including the ones that are never swept — add one there rather than reading around this.`,
    );
  }
  return resolveRetention(rule, env).days;
}

/**
 * How many un-finalised sessions one sweep may try to finalise. The bound is
 * what stops a nightly tick rebuilding a whole backlog of transcripts in one
 * run; the sweep spends it least-recently-attempted first so a session that
 * keeps failing cannot hold it.
 */
export function finalizeRepairMax(env: Env = process.env): number {
  const raw = env[FINALIZE_REPAIR_ENV];
  if (raw === undefined || raw.trim() === '') return FINALIZE_REPAIR_DEFAULT;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return FINALIZE_REPAIR_DEFAULT;
  return parsed;
}
