/**
 * ISS-1237 — `POST /api/projects/:id/issues/archive` and `.../unarchive`. One verb per direction,
 * over a filter, with a dry run; the rules are `archive.ts`'s. Project admin only, the gate the
 * project archive routes use one level down.
 */

import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { type ArchiveDirection, issueArchiveRequestSchema, runIssueArchive } from './archive.js';

export const issueArchiveRoutes = new Hono<{ Variables: AuthVars }>();
issueArchiveRoutes.use('*', requireAuth(), assertEmailVerified());

type ArchiveInput = {
  in: {
    param: z.input<typeof idParamSchema>;
    json: z.input<typeof issueArchiveRequestSchema>;
  };
  out: {
    param: z.output<typeof idParamSchema>;
    json: z.output<typeof issueArchiveRequestSchema>;
  };
};

function archiveHandler(direction: ArchiveDirection) {
  return async (c: Context<{ Variables: AuthVars }, string, ArchiveInput>) => {
    const { id: projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.admin');
    const report = await runIssueArchive({
      projectId,
      direction,
      filter: body.filter,
      dryRun: body.dryRun === true,
      actor: restActor(c),
    });
    return c.json(report);
  };
}

const validProjectId = zValidator('param', idParamSchema);

const validRequest = zValidator('json', issueArchiveRequestSchema);

issueArchiveRoutes.post(
  '/:id/issues/archive',
  validProjectId,
  validRequest,
  archiveHandler('archive'),
);
issueArchiveRoutes.post(
  '/:id/issues/unarchive',
  validProjectId,
  validRequest,
  archiveHandler('unarchive'),
);
