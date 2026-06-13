import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  devices,
  issues,
  jobStatuses,
  jobTypes,
  jobs,
  modelTiers,
  promptBlobs,
  usageRecords,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { openIssueRun, openOneShotRun } from '../pipeline/runs.js';
import { enqueueJob } from './enqueue.js';
import {
  type ActualUsage,
  type PromptEnvelope,
  extractPayloadExtras,
  extractResolvedFlags,
  redactMcpSecrets,
} from './prompt-route.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

const jobCreateSchema = z
  .object({
    type: z.enum(jobTypes),
    payload: z.record(z.string(), z.unknown()).optional(),
    issueId: z.uuid().nullable().optional(),
    modelTier: z.enum(modelTiers).nullable().optional(),
  })
  .strict();

// status changes go through enqueue + lifecycle endpoints (F3), not PATCH.
const jobPatchSchema = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
    modelTier: z.enum(modelTiers).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const jobListFiltersSchema = paginationSchema.extend({
  status: z.enum(jobStatuses).optional(),
  type: z.enum(jobTypes).optional(),
  issueId: z.uuid().optional(),
});

const projectIdParamSchema = z.object({ id: z.uuid() });
const jobIdParamSchema = z.object({ id: z.uuid() });

async function assertIssueInProject(projectId: string, issueId: string): Promise<void> {
  const [row] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw badRequest({ issueId: 'not found' });
  if (row.projectId !== projectId) throw badRequest({ issueId: 'does not belong to this project' });
}

async function loadJob(jobId: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw notFound('job not found');
  return row;
}

// Roll up usage_records for a job. Repo convention (see runs-rollup.ts) is
// `usage_records.session_id::uuid = jobs.id` — usage rows are tagged with the
// job id, not the observability agent_sessions row id. Returns null when no
// rows match.
async function loadActualUsage(jobId: string): Promise<ActualUsage | null> {
  const [row] = await db
    .select({
      input: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
      output: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
      cached: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`.mapWith(Number),
      cacheCreation:
        sql<number>`coalesce(sum(${usageRecords.cacheCreationTokens}), 0)`.mapWith(Number),
      cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
      count: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
      samples: sql<number>`count(${usageRecords.id})`.mapWith(Number),
    })
    .from(usageRecords)
    .where(sql`${usageRecords.sessionId}::uuid = ${jobId}::uuid`);
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

export const jobProjectRoutes = new Hono<{ Variables: AuthVars }>();
jobProjectRoutes.use('*', requireAuth(), assertEmailVerified());

jobProjectRoutes.post(
  '/:id/jobs',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', jobCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    if (input.issueId) await assertIssueInProject(projectId, input.issueId);

    // ISS-101 — every job needs a pipeline_run. Issue-bound jobs attach to
    // the issue's open run; project-only jobs get a one-shot 'system' run.
    const run = input.issueId
      ? await openIssueRun({ projectId, issueId: input.issueId })
      : await openOneShotRun({
          projectId,
          kind: 'system',
          metadata: { source: 'jobs.create', type: input.type },
        });

    const [inserted] = await db
      .insert(jobs)
      .values({
        projectId,
        issueId: input.issueId ?? null,
        pipelineRunId: run.id,
        createdBy: userId,
        type: input.type,
        payload: input.payload ?? {},
        modelTier: input.modelTier ?? null,
        status: 'queued',
      })
      .returning();
    if (!inserted) throw new Error('jobs: insert returned no row');

    // pg-boss publish failure does not roll back the job row — the stale-detector (F3) catches stuck queues.
    try {
      await enqueueJob({
        jobId: inserted.id,
        issueId: inserted.issueId,
        type: inserted.type,
      });
    } catch (err) {
      logger.error({ err, jobId: inserted.id }, 'enqueueJob failed; job row persisted');
    }

    return c.json(inserted, 201);
  },
);

jobProjectRoutes.get(
  '/:id/jobs',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', jobListFiltersSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const conditions = [eq(jobs.projectId, projectId)];
    if (q.status) conditions.push(eq(jobs.status, q.status));
    if (q.type) conditions.push(eq(jobs.type, q.type));
    if (q.issueId) conditions.push(eq(jobs.issueId, q.issueId));
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(jobs).where(where);

    const rows = await db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(desc(jobs.queuedAt))
      .limit(q.limit)
      .offset(q.offset);

    setTotalCount(c, Number(n));
    return c.json(rows);
  },
);

// Auth is applied per-handler so the middleware doesn't intercept device-only
// paths (POST /:id/events, /:id/complete, /:id/fail) mounted on sibling routers.
// A bare `.use('*')` would 401 those before Hono falls through to the device router.
export const jobRoutes = new Hono<{ Variables: AuthVars }>();

jobRoutes.get(
  '/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    let device: { id: string; name: string; status: string } | null = null;
    if (job.deviceId) {
      const [d] = await db
        .select({ id: devices.id, name: devices.name, status: devices.status })
        .from(devices)
        .where(eq(devices.id, job.deviceId))
        .limit(1);
      device = d ?? null;
    }

    return c.json({ ...job, device });
  },
);

jobRoutes.patch(
  '/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', jobPatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    if (job.status !== 'queued') {
      throw conflict('jobs can only be patched while queued', 'JOB_NOT_QUEUED');
    }

    const updates: Record<string, unknown> = {};
    if (patch.payload !== undefined) updates.payload = patch.payload;
    if (patch.modelTier !== undefined) updates.modelTier = patch.modelTier;

    const [updated] = await db.update(jobs).set(updates).where(eq(jobs.id, id)).returning();
    if (!updated) throw notFound('job not found');
    return c.json(updated);
  },
);

// W2.1.2 — Inspector prompt envelope. Returns the snapshot stored by W2.1.1
// (system prompt resolved through prompt_blobs, inline user prompt, blocks,
// est tokens, model, actual usage rollup) with MCP headers redacted.
jobRoutes.get(
  '/:id/prompt',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    // Archive-path stub (W2.1.5 will land the real fetcher).
    if (job.archivePath && !job.userPromptSnapshot && !job.systemPromptHash) {
      return c.json({ archived: true, path: job.archivePath }, 410);
    }

    let systemPrompt: string | null = null;
    if (job.systemPromptHash) {
      const [blob] = await db
        .select({ content: promptBlobs.content })
        .from(promptBlobs)
        .where(eq(promptBlobs.hash, job.systemPromptHash))
        .limit(1);
      systemPrompt = blob?.content ?? null;
    }

    if (!systemPrompt && !job.userPromptSnapshot) {
      throw notFound('prompt snapshot not stored (pre-v0.1.35 job)');
    }

    const actualUsage = job.agentSessionId ? await loadActualUsage(job.id) : null;

    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const mcpServersRaw = payload.mcpServers ?? null;
    const mcpConfig = mcpServersRaw == null ? null : redactMcpSecrets(mcpServersRaw);

    const envelope: PromptEnvelope = {
      jobId: job.id,
      systemPrompt,
      systemPromptHash: job.systemPromptHash ?? null,
      userPrompt: job.userPromptSnapshot,
      blocks: Array.isArray(job.promptBlocks) ? (job.promptBlocks as unknown[]) : [],
      estTokens: { input: job.promptInputTokenEst ?? null },
      actualUsage,
      mcpConfig,
      model: job.modelUsed,
      payloadExtras: extractPayloadExtras(payload),
      resolvedFlags: extractResolvedFlags(payload, {
        // skillName lives on payload (stamped by orchestrator), not a job column.
        skillName: typeof payload.skillName === 'string' ? payload.skillName : null,
        modelUsed: job.modelUsed,
      }),
    };
    return c.json(envelope);
  },
);
