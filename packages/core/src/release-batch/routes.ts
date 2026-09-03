// ISS-764 — REST surface for batch release.
//
// POST /:projectId/release-batches — create + claim a new batch (returns {runId,jobId,issueIds})
// GET  /:projectId/release-batches/active — returns the active batch for the project, or null
// GET  /:projectId/release-batches/:runId — batch context: roster, branches, deployPlanned
// POST /:projectId/release-batches/:runId/finish — close every claimed issue
// POST /:projectId/release-batches/:runId/abort — release the claims, cancel the run, close no issue

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RELEASE_RECORD_REMEDY } from '../issues/release-record-required.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  abortReleaseBatch,
  BatchInFlightError,
  ClaimConflictError,
  createReleaseBatch,
  findReleaseBatchRun,
  finishReleaseBatch,
  getActiveReleaseBatch,
  loadReleaseBatchContext,
  loadReleaseRoster,
  NoReleaseGateError,
  NoRunnerOnlineError,
  ReleaseBranchesUndeclaredError,
  ReleaseNotVerifiedError,
  ReleasePoolEmptyError,
  ReleaseRecordMissingError,
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
      if (err instanceof ReleaseBranchesUndeclaredError) throw undeclaredBranches();
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
      if (err instanceof ReleaseRecordMissingError) {
        throw conflict(
          'RELEASE_RECORD_MISSING',
          `${err.issueIds.length} issue(s) in this batch have no release note, and closing them ` +
            `would claim a ship nobody wrote anything about. ${RELEASE_RECORD_REMEDY}`,
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

const runParamSchema = z.object({ projectId: z.uuid(), runId: z.uuid() });

const finishBodySchema = z.object({ commit: z.string().trim().max(200).optional() }).strict();
const abortBodySchema = z.object({ reason: z.string().trim().max(2000).optional() }).strict();

// cm:guard resolve the run FIRST and refuse when `context.projectId` differs from the id in the path — the path id is what the PAT fence bites on, so accepting a runId that belongs to another project is exactly how a token scoped to project A finishes project B's release. The MCP tool this replaces read the project OFF the run and could not have this bug; a project-scoped URL can, and only this comparison stops it.
// cm:guard ownership only — no release plan, no branches. `abort` and `finish` must answer for a run whose project has since lost its branch declaration (or anything else the plan needs): abort is the agent's escape hatch, and an escape hatch that 500s leaves the run `running` with its claims held. Measured 2026-09-03: the three lifecycle routes all threw RELEASE_BRANCHES_UNDECLARED from here.
async function loadRunForProject(runId: string, projectId: string, userId: string) {
  const run = await findReleaseBatchRun(runId);
  if (!run || run.projectId !== projectId) throw notFound('release batch not found');

  const access = await loadProjectAccess(projectId, userId);
  if (!access) throw notFound('project not found');
  assertProjectRole(access, 'member');
}

function undeclaredBranches(): HTTPException {
  return conflict(
    'RELEASE_BRANCHES_UNDECLARED',
    'This project declares no baseBranch, so there is nothing a release could promote from',
  );
}

releaseBatchRoutes.get(
  '/:projectId/release-batches/:runId',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    try {
      return c.json(await loadReleaseBatchContext(runId));
    } catch (err) {
      if (err instanceof ReleaseBranchesUndeclaredError) throw undeclaredBranches();
      throw err;
    }
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/finish',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', finishBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);

    try {
      return c.json(
        await finishReleaseBatch(runId, { type: 'user', id: userId }, c.req.valid('json')),
      );
    } catch (err) {
      // cm:guard a refused verification is a 409 the caller ACTS on (abort with this reason), not a 500 — `reason` and `live` must survive into the body or the agent cannot tell "the deploy did not land" from "the server broke".
      if (err instanceof ReleaseNotVerifiedError) {
        throw new HTTPException(409, {
          message: err.reason,
          cause: { code: 'RELEASE_NOT_VERIFIED', reason: err.reason, live: err.live },
        });
      }
      throw err;
    }
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/abort',
  zValidator('param', runParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', abortBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);

    const releasedIds = await abortReleaseBatch(runId, reason ?? 'aborted by agent', userId);
    return c.json({ aborted: true, releasedIds });
  },
);
