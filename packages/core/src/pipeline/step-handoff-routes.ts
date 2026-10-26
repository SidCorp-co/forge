import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { resolveIssueKeyInProject } from '../issues/issue-route-ref.js';
import { assertProjectAccess } from '../lib/authz.js';
import { stepHandoffSchema } from '../memory/step-handoff-schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { resolveActor } from './activity.js';
import {
  deleteIssueContext,
  getIssueContexts,
  HandoffDeleteRefused,
  HandoffRefused,
  IssueNotInProject,
  PipelineRunNotFound,
  writeIssueContext,
} from './issue-context-store.js';
import {
  deleteHandoff,
  handoffListSchema,
  handoffWrittenSchema,
  listHandoffs,
  writeHandoff,
} from './step-handoff-routes-reference.js';

/**
 * REST surface for step handoffs, stored on the run journal's attempt rows (ISS-1133). 1-to-1 with
 * the `forge_step_handoff.*` MCP tools; both call the same service so behaviour is identical
 * regardless of caller.
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

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const stepHandoffRoutes = new Hono<{ Variables: AuthVars }>();
stepHandoffRoutes.use('*', requireAuth(), assertEmailVerified());

stepHandoffRoutes.post(
  '/',
  writeHandoff,
  zValidator('json', writeBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await assertProjectAccess(body.projectId, userId, 'member', 'write a step handoff on it');
    try {
      const r = await writeIssueContext({ ...body, kind: 'handoff', actor: resolveActor(c) });
      return c.json(answer(handoffWrittenSchema, r), 201);
    } catch (err) {
      if (err instanceof IssueNotInProject || err instanceof PipelineRunNotFound) {
        throw new HTTPException(404, { message: err.message, cause: { code: 'NOT_FOUND' } });
      }
      if (err instanceof HandoffRefused) {
        throw err.code === 'HANDOFF_NOT_THIS_ISSUE'
          ? new HTTPException(409, {
              message: err.message,
              cause: { code: 'HANDOFF_NOT_THIS_ISSUE' },
            })
          : new HTTPException(409, {
              message: err.message,
              cause: { code: 'HANDOFF_ALREADY_WRITTEN' },
            });
      }
      throw err;
    }
  },
);

stepHandoffRoutes.get(
  '/',
  listHandoffs,
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const q = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectAccess(q.projectId, userId, 'viewer', 'read its step handoffs');
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
    return c.json(answer(handoffListSchema, { rows }));
  },
);

stepHandoffRoutes.delete(
  '/',
  deleteHandoff,
  zValidator('query', deleteQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const q = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectAccess(q.projectId, userId, 'member', 'delete a step handoff on it');
    try {
      return await deleteIssueContext({
        projectId: q.projectId,
        issueId: q.issueId,
        kind: 'handoff',
        step: q.step,
        attempt: q.attempt,
      });
    } catch (err) {
      if (err instanceof HandoffDeleteRefused) {
        throw new HTTPException(409, {
          message: err.message,
          cause: { code: 'HANDOFF_IS_JOURNAL' },
        });
      }
      throw err;
    }
  },
);
