import { and, asc, count, desc, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, issues, type JobStatus, type JobType, jobEvents, jobs } from '../db/schema.js';

/** The project an issue belongs to, or null when there is no such issue. */
export async function issueProjectId(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.projectId ?? null;
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
    .orderBy(desc(jobs.queuedAt), asc(jobs.id))
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
} /** A job's events in seq order, after `sinceSeq` when given. */
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
