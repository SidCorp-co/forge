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

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../../api-reference/describe.js';
import { assertProjectRole, loadProjectAccess } from '../../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { zValidator } from '../../middleware/validator.js';
import { startRunnerRelease } from './runner-release.js';
import {
  listReleases,
  readRelease,
  releaseAnswerSchema,
  releaseListSchema,
  startRelease,
} from './runner-release-routes-reference.js';
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

const REFUSAL = {
  no_repository: { status: 409, code: 'RUNNER_RELEASE_NO_REPOSITORY' },
  bad_version: { status: 400, code: 'RUNNER_RELEASE_BAD_VERSION' },
  already_attempted: { status: 409, code: 'RUNNER_RELEASE_ALREADY_ATTEMPTED' },
  stopped: { status: 422, code: 'RUNNER_RELEASE_STOPPED' },
} as const;

runnerReleaseRoutes.post(
  '/:projectId/runner-releases',
  startRelease,
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
    if (outcome.started)
      return c.json(answer(releaseAnswerSchema, { release: outcome.release }), 202);
    const refusal = REFUSAL[outcome.kind];
    throw new HTTPException(refusal.status, {
      message: outcome.message,
      cause: { code: refusal.code, details: outcome.release },
    });
  },
);

runnerReleaseRoutes.get(
  '/:projectId/runner-releases',
  listReleases,
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    if (!access) throw notFound('project not found');
    return c.json(answer(releaseListSchema, { releases: await listForProject(projectId) }));
  },
);

runnerReleaseRoutes.get(
  '/:projectId/runner-releases/:id',
  readRelease,
  zValidator('param', releaseParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, id } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    if (!access) throw notFound('project not found');
    const release = await findById(id);
    if (!release || release.projectId !== projectId) throw notFound('runner release not found');
    return c.json(answer(releaseAnswerSchema, { release }));
  },
);
