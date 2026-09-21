/**
 * The REST surface for a runner release. ISS-1075.
 *
 * POST /api/projects/:projectId/runner-releases        — start one, naming a version
 * GET  /api/projects/:projectId/runner-releases        — every release this project has cut
 * GET  /api/projects/:projectId/runner-releases/:id    — one, with its readings and its outcome
 *
 * There is no MCP tool and no agent prompt here on purpose: a runner release is
 * a deterministic sequence with no judgement in it, which is what puts it on
 * the dispatch face rather than the MCP one.
 *
 * Every refusal carries its own sentence in `message`, because that sentence IS
 * the deliverable — which step stopped and what is now true on the repository.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { startRunnerRelease } from './runner-release.js';
import { findById, listForProject } from './runner-release-store.js';

const projectParamSchema = z.object({ projectId: z.uuid() });
const releaseParamSchema = z.object({ projectId: z.uuid(), id: z.uuid() });

const startBodySchema = z
  .object({
    version: z.string().min(1).max(64),
    commit: z.string().min(1).max(200).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const runnerReleaseRoutes = new Hono<{ Variables: AuthVars }>();
runnerReleaseRoutes.use('*', requireAuth(), assertEmailVerified());

const REFUSAL_STATUS = {
  no_repository: 409,
  bad_version: 400,
  already_attempted: 409,
  stopped: 422,
} as const;

runnerReleaseRoutes.post(
  '/:projectId/runner-releases',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', startBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access) throw notFound('project not found');
    assertProjectRole(access, 'admin');

    const outcome = await startRunnerRelease({
      projectId,
      version: body.version,
      ...(body.commit ? { commit: body.commit } : {}),
      requestedById: userId,
    });
    if (outcome.started) return c.json({ release: outcome.release }, 202);
    throw new HTTPException(REFUSAL_STATUS[outcome.kind], {
      message: outcome.message,
      cause: { code: `RUNNER_RELEASE_${outcome.kind.toUpperCase()}`, details: outcome.release },
    });
  },
);

runnerReleaseRoutes.get(
  '/:projectId/runner-releases',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    if (!access) throw notFound('project not found');
    return c.json({ releases: await listForProject(projectId) });
  },
);

runnerReleaseRoutes.get(
  '/:projectId/runner-releases/:id',
  zValidator('param', releaseParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, id } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    if (!access) throw notFound('project not found');
    const release = await findById(id);
    if (!release || release.projectId !== projectId) throw notFound('runner release not found');
    return c.json({ release });
  },
);
