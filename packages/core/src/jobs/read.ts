import { and, asc, count, desc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  devices,
  issues,
  type JobStatus,
  type JobType,
  jobEvents,
  jobs,
  promptBlobs,
  usageRecords,
} from '../db/schema.js';
import { canonicalSessionId, usageSessionMatch } from '../usage-records/rollup.js';
import type { ActualUsage } from './prompt-route.js';

/** The project an issue belongs to, or null when there is no such issue. */
export async function issueProjectId(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.projectId ?? null;
}

/** An issue's status, or null when there is no such issue. */
export async function issueStatusOf(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.status ?? null;
}

/** A project's jobs, newest queued first, one page with the filtered total. */
export async function listProjectJobs(
  projectId: string,
  filters: {
    status?: JobStatus | undefined;
    type?: JobType | undefined;
    issueId?: string | undefined;
  },
  page: { limit: number; offset: number },
): Promise<{ rows: (typeof jobs.$inferSelect)[]; total: number }> {
  const conditions = [eq(jobs.projectId, projectId)];
  if (filters.status) conditions.push(eq(jobs.status, filters.status));
  if (filters.type) conditions.push(eq(jobs.type, filters.type));
  if (filters.issueId) conditions.push(eq(jobs.issueId, filters.issueId));
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(jobs).where(where);
  const rows = await db
    .select()
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.queuedAt))
    .limit(page.limit)
    .offset(page.offset);
  return { rows, total: Number(n) };
}

/** The device a job ran on, as the job detail shows it, or null. */
export async function jobDeviceSummary(
  deviceId: string,
): Promise<{ id: string; name: string; status: string } | null> {
  const [d] = await db
    .select({ id: devices.id, name: devices.name, status: devices.status })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return d ?? null;
}

/** A stored system prompt by its hash, or null. */
export async function promptBlobContent(hash: string): Promise<string | null> {
  const [blob] = await db
    .select({ content: promptBlobs.content })
    .from(promptBlobs)
    .where(eq(promptBlobs.hash, hash))
    .limit(1);
  return blob?.content ?? null;
}

/**
 * A job's usage rollup. Usage rows are tagged with the job id
 * (`usage_records.session_id::uuid = jobs.id`, see runs-rollup.ts), not the
 * agent_sessions row id. Null when no rows match.
 */
export async function jobActualUsage(agentSessionId: string): Promise<ActualUsage | null> {
  const [row] = await db
    .select({
      input: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
      output: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
      cached: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`.mapWith(Number),
      cacheCreation: sql<number>`coalesce(sum(${usageRecords.cacheCreationTokens}), 0)`.mapWith(
        Number,
      ),
      cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
      count: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
      samples: sql<number>`count(${usageRecords.id})`.mapWith(Number),
    })
    .from(usageRecords)
    .where(usageSessionMatch(sql`= ${canonicalSessionId(agentSessionId)}`));
  if (!row || row.samples === 0) return null;
  return {
    input: row.input,
    output: row.output,
    cached: row.cached,
    cacheCreation: row.cacheCreation,
    cost: row.cost,
    count: row.count,
  };
}

/** A job's events in seq order, after `sinceSeq` when given. */
export async function listJobEvents(
  jobId: string,
  sinceSeq: number | undefined,
  limit: number,
): Promise<(typeof jobEvents.$inferSelect)[]> {
  const whereClauses = [eq(jobEvents.jobId, jobId)];
  if (sinceSeq !== undefined) whereClauses.push(gt(jobEvents.seq, sinceSeq));
  const where = whereClauses.length === 1 ? whereClauses[0] : and(...whereClauses);
  return db.select().from(jobEvents).where(where).orderBy(asc(jobEvents.seq)).limit(limit);
}

/** The device a job is dispatched to and the issue it serves, or null. */
export async function jobDispatchOf(
  jobId: string,
): Promise<{ deviceId: string | null; issueId: string | null } | null> {
  const [job] = await db
    .select({ deviceId: jobs.deviceId, issueId: jobs.issueId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  return job ?? null;
}
