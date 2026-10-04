import { and, count, desc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type UsageSource, usageRecords } from '../db/schema.js';
import { utcDayText } from '../lib/time-buckets.js';

export type UsageRecordRow = typeof usageRecords.$inferSelect;

/** One page of a project's usage records, newest first, and the total the filter matched. */
export async function listUsageRecords(filter: {
  projectId: string;
  source?: UsageSource | undefined;
  model?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
  offset: number;
}): Promise<{ rows: UsageRecordRow[]; total: number }> {
  const conditions: SQL[] = [eq(usageRecords.projectId, filter.projectId)];
  if (filter.source) conditions.push(eq(usageRecords.source, filter.source));
  if (filter.model) conditions.push(eq(usageRecords.model, filter.model));
  if (filter.from) conditions.push(gte(usageRecords.recordedAt, filter.from));
  if (filter.to) conditions.push(lte(usageRecords.recordedAt, filter.to));

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(usageRecords)
      .where(and(...conditions))
      .orderBy(desc(usageRecords.recordedAt))
      .limit(filter.limit)
      .offset(filter.offset),
    db
      .select({ n: count() })
      .from(usageRecords)
      .where(and(...conditions)),
  ]);
  return { rows, total: totalRow?.n ?? 0 };
}

const sums = {
  input: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
  output: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
  cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
  requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
};

/** A project's usage over the last `days`: totals, per UTC day, per model and per source. */
export async function readUsageSummary(projectId: string, days: number) {
  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = and(eq(usageRecords.projectId, projectId), gte(usageRecords.recordedAt, fromDate));
  const day = utcDayText(sql`${usageRecords.recordedAt}`);

  const [totals] = await db
    .select({
      inputTokens: sums.input,
      outputTokens: sums.output,
      estimatedCost: sums.cost,
      requests: sums.requests,
    })
    .from(usageRecords)
    .where(where);

  const daily = await db
    .select({ date: sql<string>`${day}`, ...sums })
    .from(usageRecords)
    .where(where)
    .groupBy(day)
    .orderBy(day);

  const byModel = await db
    .select({ model: usageRecords.model, ...sums })
    .from(usageRecords)
    .where(where)
    .groupBy(usageRecords.model);

  const bySource = await db
    .select({ source: usageRecords.source, ...sums })
    .from(usageRecords)
    .where(where)
    .groupBy(usageRecords.source);

  return {
    totals: totals ?? { inputTokens: 0, outputTokens: 0, estimatedCost: 0, requests: 0 },
    daily,
    byModel,
    bySource,
  };
}

/** One usage record by id, or null. */
export async function findUsageRecord(id: string): Promise<UsageRecordRow | null> {
  const [row] = await db.select().from(usageRecords).where(eq(usageRecords.id, id)).limit(1);
  return row ?? null;
}
