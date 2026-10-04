// REST endpoints for the Update Pipeline stage ② (Reconcile) service.
// Mounted at /api/projects/:projectId/reconcile-runs (and /api/reconcile for
// cross-project admin views) in packages/core/src/index.ts.
//
// Mutating endpoints require project admin role, except a verifier's vote, which takes
// membership. Read endpoints require project membership.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import {
  acknowledgeReconcileRun,
  applyReconcileRun,
  getReconcileRun,
  listReconcileRunsForProject,
  recordReconcileVerdict,
  recordVerifierVote,
  rejectReconcileRun,
  spawnReconcileRun,
} from './reconcile-service.js';
import { refuse } from './refuse.js';

const projectParamSchema = z.object({ projectId: z.string().uuid() });
const runParamSchema = z.object({ projectId: z.string().uuid(), runId: z.string().uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const notFound = (msg: string) =>
  new HTTPException(404, { message: msg, cause: { code: 'NOT_FOUND' } });

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
    requireHeld(access, 'project.admin');

    const result = await spawnReconcileRun({ projectId, packetId, skillId, actorUserId: userId });

    if (!result.ok) {
      if (result.reason === 'already-active') throw refuse('RECONCILE_RUN_ACTIVE', result.detail);
      if (result.reason === 'c1-c5-refused') throw refuse('C1_C5_REFUSED', result.detail);
      if (result.reason === 'no-runner') throw refuse('NO_RUNNER_ONLINE', result.detail);
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
    requireHeld(access, 'project.read');

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
    requireHeld(access, 'project.read');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);

    return c.json({ run });
  },
);

const verdictBodySchema = z
  .object({
    verdict: z.enum(['no-op', 'apply', 'apply-with-adaptation', 'escalate']),
    candidateBody: z.string().optional(),
    rationale: z.string().min(1).max(5000),
    gate: z.enum(['auto', 'human']),
  })
  .strict()
  .refine(
    (b) => !(b.verdict === 'apply' || b.verdict === 'apply-with-adaptation') || !!b.candidateBody,
    { message: 'candidateBody is required when verdict is apply or apply-with-adaptation' },
  );

/** The master agent's verdict and candidate body for an in-flight run. */
reconcileRoutes.post(
  '/:projectId/reconcile-runs/:runId/verdict',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', verdictBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);
    if (run.status !== 'pending' && run.status !== 'running') {
      throw refuse(
        'RECONCILE_RUN_NOT_OPEN',
        `reconcile run ${runId} is ${run.status}; a verdict is recorded on a pending or running run`,
      );
    }

    await recordReconcileVerdict({
      runId,
      verdict: body.verdict,
      candidateBody: body.candidateBody ?? null,
      rationale: body.rationale,
      gate: body.gate,
      actor: 'agent:master',
    });
    return c.json({ ok: true });
  },
);

/** A verifier agent's pass/fail vote on a run in `verifying`. */
reconcileRoutes.post(
  '/:projectId/reconcile-runs/:runId/votes',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator(
    'json',
    z
      .object({
        jobId: z.string().uuid(),
        vote: z.enum(['pass', 'fail']),
        reason: z.string().min(1).max(2000),
      })
      .strict(),
    (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    },
  ),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const { jobId, vote, reason } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);
    if (run.status !== 'verifying') {
      throw refuse(
        'RECONCILE_RUN_NOT_VERIFYING',
        `reconcile run ${runId} is ${run.status}; a vote is recorded on a verifying run`,
      );
    }

    await recordVerifierVote({ runId, jobId, vote, reason });
    return c.json({ ok: true });
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
    requireHeld(access, 'project.admin');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);

    try {
      await applyReconcileRun(runId, userId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('NOT_FOUND:')) throw notFound(msg);
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
    requireHeld(access, 'project.admin');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);

    try {
      await rejectReconcileRun(runId, userId, reason);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('NOT_FOUND:')) throw notFound(msg);
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
    requireHeld(access, 'project.admin');

    const run = await getReconcileRun(runId);
    if (!run || run.projectId !== projectId) throw notFound(`reconcile run ${runId} not found`);

    try {
      await acknowledgeReconcileRun(runId, userId, reason);
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.startsWith('NOT_FOUND:')) throw notFound(msg);
      throw err;
    }

    return c.json({ ok: true });
  },
);
