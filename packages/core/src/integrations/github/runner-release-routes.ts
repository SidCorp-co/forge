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
 * Every refusal carries its own sentence in its detail, because that sentence IS
 * the deliverable — which step stopped and what is now true on the repository.
 */

import type { RunnerReleaseRefusalCode } from '@forge/contracts/integrations';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../../lib/authz.js';
import { refuser } from '../../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../middleware/route-errors.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { startRunnerRelease } from './runner-release.js';
import { findById, listForProject } from './runner-release-store.js';
import { requireHeld } from '../../permissions/index.js';

const projectParamSchema = z.object({ projectId: z.uuid() });
const releaseParamSchema = z.object({ projectId: z.uuid(), id: z.uuid() });

const startBodySchema = z
  .object({
    version: z.string().min(1).max(64),
    commit: z.string().min(1).max(200).optional(),
  })
  .strict();

export const runnerReleaseRoutes = new Hono<{ Variables: AuthVars }>();
runnerReleaseRoutes.use('*', requireAuth(), assertEmailVerified());

const refuse = refuser<RunnerReleaseRefusalCode>('RUNNER_RELEASE_REFUSED');

const REFUSAL_CODE = {
  no_repository: 'RUNNER_RELEASE_NO_REPOSITORY',
  already_attempted: 'RUNNER_RELEASE_ALREADY_ATTEMPTED',
  stopped: 'RUNNER_RELEASE_STOPPED',
} as const satisfies Record<string, RunnerReleaseRefusalCode>;

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
    requireHeld(access, 'project.admin');

    const outcome = await startRunnerRelease({
      projectId,
      version: body.version,
      ...(body.commit ? { commit: body.commit } : {}),
      requestedById: userId,
    });
    if (outcome.started) return c.json({ release: outcome.release }, 202);
    if (outcome.kind === 'bad_version') {
      throw new HTTPException(400, {
        message: outcome.message,
        cause: { code: 'RUNNER_RELEASE_BAD_VERSION' },
      });
    }
    const held = outcome.release ? ` Release ${outcome.release.id} holds what happened.` : '';
    throw refuse(REFUSAL_CODE[outcome.kind], `${outcome.message}${held}`, '/version');
  },
);

runnerReleaseRoutes.get(
  '/:projectId/runner-releases',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const _access = await loadProjectAccess(projectId, c.get('userId'));
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
    const _access = await loadProjectAccess(projectId, c.get('userId'));
    const release = await findById(id);
    if (!release || release.projectId !== projectId) throw notFound('runner release not found');
    return c.json({ release });
  },
);
