import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { jobStatuses, jobTypes, modelTiers } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { openIssueRun, openOneShotRun } from '../pipeline/index.js';
import { readJob } from './job-queries.js';
import { noPromptMessage, poolPrompt } from './pool-served.js';
import { issueProjectId, jobDeviceSummary, listProjectJobs } from './read.js';
import { refuseJob } from './refusals.js';
import { createQueuedJob, patchJob } from './service.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const jobCreateSchema = z
  .object({
    type: z.enum(jobTypes),
    payload: z.record(z.string(), z.unknown()).optional(),
    issueId: z.uuid().nullable().optional(),
    modelTier: z.enum(modelTiers).nullable().optional(),
  })
  .strict();

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
  const issueProject = await issueProjectId(issueId);
  if (!issueProject) throw badRequest({ issueId: 'not found' });
  if (issueProject !== projectId) throw badRequest({ issueId: 'does not belong to this project' });
}

async function loadJob(jobId: string) {
  const row = await readJob(jobId);
  if (!row) throw notFound('job not found');
  return row;
}

export const jobProjectRoutes = new Hono<{ Variables: AuthVars }>();
jobProjectRoutes.use('*', requireAuth(), assertEmailVerified());

jobProjectRoutes.post(
  '/:id/jobs',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', jobCreateSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');

    if (input.issueId) await assertIssueInProject(projectId, input.issueId);
    if (poolPrompt(input.payload) === null) {
      throw refuseJob('POOL_JOB_NO_PROMPT', noPromptMessage(input.type), '/payload');
    }

    // ISS-101 — every job needs a pipeline_run. Issue-bound jobs attach to
    // the issue's open run; project-only jobs get a one-shot 'system' run.
    const run = input.issueId
      ? await openIssueRun({ projectId, issueId: input.issueId })
      : await openOneShotRun({
          projectId,
          kind: 'system',
          metadata: { source: 'jobs.create', type: input.type },
        });

    const inserted = await createQueuedJob({
      projectId,
      issueId: input.issueId ?? null,
      pipelineRunId: run.id,
      createdBy: userId,
      type: input.type,
      payload: input.payload ?? {},
      modelTier: input.modelTier ?? null,
    });

    return c.json(inserted, 201);
  },
);

jobProjectRoutes.get(
  '/:id/jobs',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', jobListFiltersSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const { rows, total } = await listProjectJobs(
      projectId,
      { status: q.status, type: q.type, issueId: q.issueId },
      { limit: q.limit, offset: q.offset },
    );

    return c.json(listResponse(c, rows, total, q));
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
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    requireHeld(access, 'project.read');

    const device = job.deviceId ? await jobDeviceSummary(job.deviceId) : null;

    return c.json({ ...job, device });
  },
);

jobRoutes.patch(
  '/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', jobPatchSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    requireHeld(access, 'project.write');

    if (job.status !== 'queued') {
      throw refuseJob('JOB_NOT_QUEUED', 'jobs can only be patched while queued');
    }

    const updated = await patchJob(id, {
      ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
      ...(patch.modelTier !== undefined ? { modelTier: patch.modelTier } : {}),
    });
    if (!updated) throw notFound('job not found');
    return c.json(updated);
  },
);

export { jobEventsListRoutes, jobEventsRoutes } from './events-routes.js';
export { jobLifecycleDeviceRoutes, jobLifecycleUserRoutes } from './lifecycle-routes.js';
