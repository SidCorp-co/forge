import { type SQL, and, asc, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { jobEvents, jobStatuses, jobTypes, jobs } from '../../db/schema.js';
import { JobCancelError, cancelJob } from '../../jobs/cancel-job.js';
import {
  type ContextScopedMcpToolFactory,
  type DeviceScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  principalUserId,
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

// ISS-478 fix-forward — the body-free projection bounds per-ROW size but not
// the TOTAL response. At the old default limit of 50, a real-history project
// still produced ~52K chars and overflowed the MCP output cap, spilling to a
// file (the very failure this issue fixes, just 16× smaller). So ALSO bound the
// total response: a smaller default limit for the common no-arg call, plus a
// hard char budget that trims rows from the tail (oldest first — the list is
// ordered queuedAt desc) until the serialized payload fits. ~38K leaves
// headroom under the observed spill threshold (40 rows/~41K fit, 50/~52K did
// not).
const DEFAULT_LIST_LIMIT = 25;
const MAX_RESPONSE_CHARS = 38_000;

const getInputSchema = z.object({ jobId: z.uuid() }).strict();

const eventsInputSchema = z
  .object({
    jobId: z.uuid(),
    sinceSeq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const cancelInputSchema = z
  .object({
    jobId: z.uuid(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export const forgeJobsListTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_jobs.list',
  description:
    'List jobs scoped to a project (default 25, max 200; ordered newest-first). Supports status/type/issueId filters. Returns a lightweight projection per job: the heavy fields (payload, promptBlocks, failureMeta jsonb and the unbounded userPromptSnapshot/error text) are OMITTED to stay under the response token cap — fetch them per-job via forge_jobs.get. A hard response-size cap trims the oldest rows when needed; when that happens the result carries truncated:true + a notice (narrow with filters or a smaller limit). Requires device owner to be a project member.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId, status, type, issueId, limit } = listInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, projectId);

    const conds: SQL[] = [eq(jobs.projectId, projectId)];
    if (status) conds.push(eq(jobs.status, status));
    if (type) conds.push(eq(jobs.type, type));
    if (issueId) conds.push(eq(jobs.issueId, issueId));

    // ISS-478 (sibling of ISS-428) — explicit body-free projection. NEVER
    // `db.select()` here: the `payload`/`promptBlocks`/`failureMeta` jsonb plus
    // the unbounded `userPromptSnapshot`/`error` text overflow the MCP token cap
    // (~862K chars observed live) and crash fragile agents. Heavy fields stay in
    // `.get`.
    const rows = await db
      .select({
        id: jobs.id,
        projectId: jobs.projectId,
        issueId: jobs.issueId,
        pipelineRunId: jobs.pipelineRunId,
        deviceId: jobs.deviceId,
        runnerId: jobs.runnerId,
        createdBy: jobs.createdBy,
        type: jobs.type,
        status: jobs.status,
        queuedAt: jobs.queuedAt,
        dispatchedAt: jobs.dispatchedAt,
        ackedAt: jobs.ackedAt,
        finishedAt: jobs.finishedAt,
        exitCode: jobs.exitCode,
        modelTier: jobs.modelTier,
        attempts: jobs.attempts,
        cancellationRequested: jobs.cancellationRequested,
        retryOf: jobs.retryOf,
        retryAfterAt: jobs.retryAfterAt,
        agentSessionId: jobs.agentSessionId,
        failureKind: jobs.failureKind,
        failureReason: jobs.failureReason,
        classifierVersion: jobs.classifierVersion,
        systemPromptHash: jobs.systemPromptHash,
        promptInputTokenEst: jobs.promptInputTokenEst,
        modelUsed: jobs.modelUsed,
        archivePath: jobs.archivePath,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(and(...conds))
      .orderBy(desc(jobs.queuedAt))
      .limit(limit ?? DEFAULT_LIST_LIMIT);

    // Hard total-response cap: trim from the tail (oldest) until the serialized
    // payload fits MAX_RESPONSE_CHARS, so a large explicit `limit` (or a verbose
    // run of jobs) can never spill to a file. Always keep at least one row.
    let kept = rows;
    while (kept.length > 1 && JSON.stringify({ jobs: kept }).length > MAX_RESPONSE_CHARS) {
      kept = kept.slice(0, -1);
    }

    if (kept.length < rows.length) {
      return {
        jobs: kept,
        truncated: true,
        returned: kept.length,
        requested: limit ?? DEFAULT_LIST_LIMIT,
        notice: `Response truncated to the ${kept.length} most recent of ${rows.length} jobs to stay under the MCP output cap. Narrow with status/type/issueId filters or a smaller limit; fetch full job bodies via forge_jobs.get.`,
      };
    }

    return { jobs: kept };
  },
});

export const forgeJobsGetTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_jobs.get',
  description:
    'Fetch a single job by id including its linked agentSessionId. Requires the principal to be a member of the job’s project; PAT principals must additionally have the job’s project in their allowlist.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { jobId } = getInputSchema.parse(args);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!row) throw new Error('NOT_FOUND: job not found');
    await assertPrincipalIsMember(principal, row.projectId);
    return { job: row };
  },
});

export const forgeJobsEventsTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_jobs.events',
  description:
    'Stream-replay job_events for a job (paginated by sinceSeq). Read-only; returns { items, lastSeq }.',
  inputSchema: zodToMcpSchema(eventsInputSchema),
  handler: async (args) => {
    const { jobId, sinceSeq, limit } = eventsInputSchema.parse(args);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw new Error('NOT_FOUND: job not found');
    await assertPrincipalIsMember(principal, job.projectId);

    const whereClauses: SQL[] = [eq(jobEvents.jobId, jobId)];
    if (sinceSeq !== undefined) whereClauses.push(gt(jobEvents.seq, sinceSeq));
    const where = whereClauses.length === 1 ? whereClauses[0] : and(...whereClauses);

    const items = await db
      .select()
      .from(jobEvents)
      .where(where)
      .orderBy(asc(jobEvents.seq))
      .limit(limit ?? 200);

    const lastSeq = items.length > 0 ? Number(items[items.length - 1]?.seq ?? 0) : (sinceSeq ?? 0);
    return { items, lastSeq };
  },
});

/**
 * ISS-442 C0 — the audited manual single-job cancel escape hatch. Delegates to
 * the shared {@link cancelJob} helper (same logic as REST `POST /jobs/:id/cancel`),
 * so it works even when the parent pipeline_run is already terminal — the case
 * that previously forced raw-SQL surgery. Writer-gated (this is a destructive
 * mutation), unlike the read-only forge_jobs.* tools which use the member gate.
 * Every cancel writes one `job_events` row (`kind='intervention'`) for the C6
 * interventions metric.
 */
export const forgeJobsCancelTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_jobs.cancel',
  description:
    'Cancel a single job (audited manual intervention). queued → cancelled; dispatched/running → cancellation requested + device push. Works even when the parent pipeline_run is already terminal (orphan escape hatch). Requires writer access (member/admin; PAT write scope).',
  inputSchema: zodToMcpSchema(cancelInputSchema),
  handler: async (args) => {
    const { jobId, reason } = cancelInputSchema.parse(args);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw new Error('NOT_FOUND: job not found');
    await assertPrincipalIsWriter(principal, job.projectId);

    try {
      return await cancelJob(jobId, {
        actorUserId: principalUserId(principal),
        reason: reason ?? 'manual cancel (MCP)',
        source: 'mcp',
      });
    } catch (e) {
      if (e instanceof JobCancelError) throw new Error(`${e.code}: ${e.message}`);
      throw e;
    }
  },
});
