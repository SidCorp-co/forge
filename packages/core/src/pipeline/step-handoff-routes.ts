import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { stepHandoffSchema } from '../memory/step-handoff-schema.js';
import {
  deleteIssueContext,
  getIssueContexts,
  writeIssueContext,
} from './issue-context-store.js';

/**
 * REST surface for step-handoff persistence (proposal Y). 1-to-1 with the
 * `forge_step_handoff.*` MCP tools; both call the same service so behaviour
 * is identical regardless of caller.
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
  issueId: z.uuid(),
  pipelineRunId: z.uuid().optional(),
  // CSV in query string — clients pass `?steps=triage,plan` for the
  // injection allow-list path.
  steps: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  orderDir: z.enum(['asc', 'desc']).default('desc'),
});

const deleteQuerySchema = z.object({
  projectId: z.uuid(),
  issueId: z.uuid(),
  step: z.string().trim().min(1).max(64),
  attempt: z.coerce.number().int().positive(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

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
    await assertProjectAccess(body.projectId, userId);
    const r = await writeIssueContext({ ...body, kind: 'handoff' });
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
    await assertProjectAccess(q.projectId, userId, 'viewer');
    const rows = await getIssueContexts({
      projectId: q.projectId,
      issueId: q.issueId,
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
    await assertProjectAccess(q.projectId, userId);
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
