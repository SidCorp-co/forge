import { Hono } from 'hono';
import { z } from 'zod';
import { resolveIssueKeyInProject } from '../issues/issue-route-ref.js';
import { stepHandoffSchema } from '../memory/step-handoff-schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { resolveActor } from './activity.js';
import { deleteIssueContext, getIssueContexts, writeIssueContext } from './issue-context-store.js';
import { requireCan } from '../permissions/index.js';

/**
 * REST surface for step-handoff persistence (proposal Y), over the one
 * service in `./issue-context-store.ts`.
 */

const writeBodySchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  pipelineRunId: z.uuid(),
  step: z.string().trim().min(1).max(64),
  attempt: z.number().int().positive().default(1),
  payload: stepHandoffSchema,
});

const listQuerySchema = z.object({
  projectId: z.uuid(),
  // ISS-1160 — the screen this feeds passes the display key it has (`ISS-1185`),
  // not a uuid; `projectId` above is already the scope a key resolves inside.
  issueId: z.string().trim().min(1).max(200),
  pipelineRunId: z.uuid().optional(),
  steps: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  orderDir: z.enum(['asc', 'desc']).default('desc'),
});

const deleteQuerySchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  step: z.string().trim().min(1).max(64),
  attempt: z.coerce.number().int().positive(),
});

export const stepHandoffRoutes = new Hono<{ Variables: AuthVars }>();
stepHandoffRoutes.use('*', requireAuth(), assertEmailVerified());

stepHandoffRoutes.post(
  '/',
  zValidator('json', writeBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireCan({ userId }, 'project.write', body.projectId);
    const r = await writeIssueContext({ ...body, kind: 'handoff', actor: resolveActor(c) });
    return c.json(r, 201);
  },
);

stepHandoffRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const q = c.req.valid('query');
    const userId = c.get('userId');
    await requireCan({ userId }, 'project.read', q.projectId);
    const issueId = await resolveIssueKeyInProject(q.issueId, q.projectId);
    const rows = await getIssueContexts({
      projectId: q.projectId,
      issueId,
      kind: 'handoff',
      ...(q.pipelineRunId ? { pipelineRunId: q.pipelineRunId } : {}),
      ...(q.steps ? { steps: q.steps } : {}),
      limit: q.limit,
      orderDir: q.orderDir,
    });
    return c.json({ rows });
  },
);

stepHandoffRoutes.delete(
  '/',
  zValidator('query', deleteQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const q = c.req.valid('query');
    const userId = c.get('userId');
    await requireCan({ userId }, 'project.write', q.projectId);
    const n = await deleteIssueContext({
      projectId: q.projectId,
      issueId: q.issueId,
      kind: 'handoff',
      step: q.step,
      attempt: q.attempt,
    });
    return c.json({ deleted: n > 0 });
  },
);
