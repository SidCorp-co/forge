import { type SQL, and, asc, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { jobEvents, jobStatuses, jobTypes, jobs } from '../../db/schema.js';
import {
  type DeviceScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
  zodToMcpSchema,
} from './lib.js';

/**
 * MCP Phase 1 (ISS-7) — read-only diagnostic surfaces over the jobs/events
 * tables. Mirrors the drizzle queries used by the REST job routes
 * (`packages/core/src/jobs/routes.ts`, `events-routes.ts`) but skips Hono so
 * MCP callers do not need an authenticated user session — project membership
 * is enforced via the device principal.
 */

const listInputSchema = z
  .object({
    projectId: z.uuid(),
    status: z.enum(jobStatuses).optional(),
    type: z.enum(jobTypes).optional(),
    issueId: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const getInputSchema = z.object({ jobId: z.uuid() }).strict();

const eventsInputSchema = z
  .object({
    jobId: z.uuid(),
    sinceSeq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const forgeJobsListTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_jobs.list',
  description:
    'List jobs scoped to a project. Supports status/type/issueId filters. Requires device owner to be a project member.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId, status, type, issueId, limit } = listInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, projectId);

    const conds: SQL[] = [eq(jobs.projectId, projectId)];
    if (status) conds.push(eq(jobs.status, status));
    if (type) conds.push(eq(jobs.type, type));
    if (issueId) conds.push(eq(jobs.issueId, issueId));

    const rows = await db
      .select()
      .from(jobs)
      .where(and(...conds))
      .orderBy(desc(jobs.queuedAt))
      .limit(limit ?? 50);

    return { jobs: rows };
  },
});

export const forgeJobsGetTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_jobs.get',
  description:
    'Fetch a single job by id including its linked agentSessionId. Requires device owner to be a member of the job’s project.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { jobId } = getInputSchema.parse(args);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!row) throw new Error('NOT_FOUND: job not found');
    await assertDeviceOwnerIsMember(device, row.projectId);
    return { job: row };
  },
});

export const forgeJobsEventsTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_jobs.events',
  description:
    'Stream-replay job_events for a job (paginated by sinceSeq). Read-only; returns { items, lastSeq }.',
  inputSchema: zodToMcpSchema(eventsInputSchema),
  handler: async (args) => {
    const { jobId, sinceSeq, limit } = eventsInputSchema.parse(args);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw new Error('NOT_FOUND: job not found');
    await assertDeviceOwnerIsMember(device, job.projectId);

    const whereClauses: SQL[] = [eq(jobEvents.jobId, jobId)];
    if (sinceSeq !== undefined) whereClauses.push(gt(jobEvents.seq, sinceSeq));
    const where = whereClauses.length === 1 ? whereClauses[0] : and(...whereClauses);

    const items = await db
      .select()
      .from(jobEvents)
      .where(where)
      .orderBy(asc(jobEvents.seq))
      .limit(limit ?? 200);

    const lastSeq =
      items.length > 0 ? Number(items[items.length - 1]?.seq ?? 0) : (sinceSeq ?? 0);
    return { items, lastSeq };
  },
});
