// REST endpoints for the Update Pipeline stage ② (Reconcile) service.
// Mounted at /api/projects/:projectId/reconcile-runs (and /api/reconcile for
// cross-project admin views) in packages/core/src/index.ts.
//
// All mutating endpoints require project admin role. Read endpoints require
// project membership.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  acknowledgeReconcileRun,
  applyReconcileRun,
  getReconcileRun,
  listReconcileRunsForProject,
  rejectReconcileRun,
  spawnReconcileRun,
} from './reconcile-service.js';

const projectParamSchema = z.object({ projectId: z.string().uuid() });
const runParamSchema = z.object({ projectId: z.string().uuid(), runId: z.string().uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const forbidden = (msg: string) =>
  new HTTPException(403, { message: msg, cause: { code: 'FORBIDDEN' } });
const notFound = (msg: string) =>
  new HTTPException(404, { message: msg, cause: { code: 'NOT_FOUND' } });
const conflict = (msg: string) =>
  new HTTPException(409, { message: msg, cause: { code: 'CONFLICT' } });

export const reconcileRoutes = new Hono<{ Variables: AuthVars }>();
reconcileRoutes.use('/:projectId/reconcile-runs*', requireAuth(), assertEmailVerified());

reconcileRoutes.post(
  '/:projectId/reconcile-runs',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator(
    'json',
    z
      .object({
        packetId: z.string().uuid(),
        skillId: z.string().uuid(),
      })
      .strict(),
    (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    },
  ),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { packetId, skillId } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'only a project admin can trigger a reconcile run');

    const result = await spawnReconcileRun({ projectId, packetId, skillId, actorUserId: userId });

    if (!result.ok) {
      if (result.reason === 'already-active') throw conflict(result.detail);
      if (result.reason === 'c1-c5-refused')
        throw badRequest({ code: 'C1_C5_REFUSED', message: result.detail });
      if (result.reason === 'no-runner') throw conflict(`NO_RUNNER_ONLINE: ${result.detail}`);
      throw new HTTPException(500, { message: result.detail });
    }

    return c.json({ runId: result.runId }, 201);
  },
);

reconcileRoutes.get(
  '/:projectId/reconcile-runs',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const runs = await listReconcileRunsForProject(projectId);
    return c.json({ runs });
  },
);

reconcileRoutes.get(
  '/:projectId/reconcile-runs/:runId',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);

    return c.json({ run });
  },
);

reconcileRoutes.post(
  '/:projectId/reconcile-runs/:runId/apply',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'only a project admin can apply a reconcile run');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);

    try {
      await applyReconcileRun(runId, userId);
    } catch (err: unknown) {
      // cm:why ISS-808 — String(err) on an Error prepends "Error: ", so the BAD_REQUEST/NOT_FOUND prefix match below never fired and every guard rejection fell through to a 500
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('NOT_FOUND:')) throw notFound(msg);
      if (msg.startsWith('BAD_REQUEST:')) throw badRequest(msg);
      throw err;
    }

    return c.json({ ok: true });
  },
);

reconcileRoutes.post(
  '/:projectId/reconcile-runs/:runId/reject',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', z.object({ reason: z.string().min(1).max(1000) }).strict(), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'only a project admin can reject a reconcile run');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);

    try {
      await rejectReconcileRun(runId, userId, reason);
    } catch (err: unknown) {
      // cm:why ISS-808 — String(err) on an Error prepends "Error: ", so the BAD_REQUEST/NOT_FOUND prefix match below never fired and every guard rejection fell through to a 500
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('NOT_FOUND:')) throw notFound(msg);
      if (msg.startsWith('BAD_REQUEST:')) throw badRequest(msg);
      throw err;
    }

    return c.json({ ok: true });
  },
);

reconcileRoutes.post(
  '/:projectId/reconcile-runs/:runId/acknowledge',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', z.object({ reason: z.string().max(1000).optional() }).strict(), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'only a project admin can acknowledge a reconcile run');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);

    try {
      await acknowledgeReconcileRun(runId, userId, reason);
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.startsWith('NOT_FOUND:')) throw notFound(msg);
      if (msg.startsWith('BAD_REQUEST:')) throw badRequest(msg);
      throw err;
    }

    return c.json({ ok: true });
  },
);
