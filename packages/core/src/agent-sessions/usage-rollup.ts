import { inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, usageRecords } from '../db/schema.js';

export function canonicalSessionId(value: unknown): SQL {
  return sql`${value}::uuid::text`;
}

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

export type UsageTotals = { -readonly [K in keyof typeof EMPTY_USAGE_TOTALS]: number };

/**
 * Usage totals per pipeline run, read through the sessions that ran under it. A run with no usage
 * row is absent from the map.
 */
export async function usageTotalsByRun(
  runIds: readonly string[],
): Promise<Map<string, UsageTotals>> {
  const out = new Map<string, UsageTotals>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select({ runId: agentSessions.pipelineRunId, ...usageTotalsSelection() })
    .from(usageRecords)
    .innerJoin(agentSessions, usageSessionMatch(sql`= ${agentSessions.id}::text`))
    .where(inArray(agentSessions.pipelineRunId, [...runIds]))
    .groupBy(agentSessions.pipelineRunId);
  for (const { runId, ...totals } of rows) if (runId) out.set(runId, totals);
  return out;
}

/** One run's usage totals, zero where it has none. */
export async function usageTotalsForRun(runId: string): Promise<UsageTotals> {
  return (await usageTotalsByRun([runId])).get(runId) ?? { ...EMPTY_USAGE_TOTALS };
}
