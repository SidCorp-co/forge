import { type SQL, sql } from 'drizzle-orm';
import { usageRecords } from '../db/schema.js';

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
