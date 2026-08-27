// ISS-764 — REST surface for batch release.
//
// POST /:projectId/release-batches — create + claim a new batch (returns {runId,jobId,issueIds})
// GET  /:projectId/release-batches/active — returns the active batch for the project, or null

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  BatchInFlightError,
  ClaimConflictError,
  createReleaseBatch,
  getActiveReleaseBatch,
  loadReleaseRoster,
  NoReleaseGateError,
  NoRunnerOnlineError,
  ReleasePoolEmptyError,
} from './service.js';

const projectParamSchema = z.object({ projectId: z.uuid() });

const createBodySchema = z
  .object({
    issueIds: z.array(z.uuid()).min(1).max(50),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const conflict = (code: string, message: string) =>
  new HTTPException(409, { message, cause: { code } });

const serviceUnavailable = (code: string, message: string) =>
  new HTTPException(503, { message, cause: { code } });

export const releaseBatchRoutes = new Hono<{ Variables: AuthVars }>();
releaseBatchRoutes.use('*', requireAuth(), assertEmailVerified());

releaseBatchRoutes.post(
  '/:projectId/release-batches',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', createBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { issueIds } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'admin');

    try {
      const result = await createReleaseBatch({ projectId, issueIds, userId });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof NoReleaseGateError) {
        throw conflict('NO_RELEASE_GATE', 'This project has no release gate configured');
      }
      if (err instanceof ReleasePoolEmptyError) {
        throw serviceUnavailable(
          'RELEASE_POOL_EMPTY',
          `No runner carries the release label \`${err.label}\`, so nothing here may deploy`,
        );
      }
      if (err instanceof NoRunnerOnlineError) {
        throw serviceUnavailable('NO_RUNNER_ONLINE', 'No runner is online for this project');
      }
      if (err instanceof ClaimConflictError) {
        throw conflict(
          'CLAIM_CONFLICT',
          'One or more issues could not be claimed (wrong status or already in a batch)',
        );
      }
      if (err instanceof BatchInFlightError) {
        throw conflict(
          'BATCH_IN_FLIGHT',
          'A batch release is already in progress for this project',
        );
      }
      throw err;
    }
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-batches/active',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'member');

    const active = await getActiveReleaseBatch(projectId);
    return c.json(active ?? null);
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-batches/roster',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'member');

    return c.json(await loadReleaseRoster(projectId));
  },
);
