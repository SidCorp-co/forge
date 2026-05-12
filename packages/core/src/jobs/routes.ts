import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { devices, issues, jobStatuses, jobTypes, jobs, modelTiers } from '../db/schema.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { openIssueRun, openOneShotRun } from '../pipeline/runs.js';
import { enqueueJob } from './enqueue.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

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
      await enqueueJob(inserted.id);
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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

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
