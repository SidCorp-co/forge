/**
 * ISS-1237 — `POST /api/projects/:id/issues/archive` and `.../unarchive`. One verb per direction,
 * over a filter, with a dry run; the rules are `archive.ts`'s. Project admin only, the gate the
 * project archive routes use one level down.
 */

import { zValidator } from '@hono/zod-validator';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import {
  type ArchiveDirection,
  IssueArchiveRefusedError,
  issueArchiveRequestSchema,
  runIssueArchive,
} from './archive.js';

const projectIdParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const issueArchiveRoutes = new Hono<{ Variables: AuthVars }>();
issueArchiveRoutes.use('*', requireAuth(), assertEmailVerified());

function archiveHandler(direction: ArchiveDirection) {
  return async (c: Context<{ Variables: AuthVars }>) => {
    const { id: projectId } = projectIdParamSchema.parse(c.req.param());
    const parsed = issueArchiveRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
    const access = await loadProjectAccess(projectId, c.get('userId'));
    assertProjectRole(access, 'admin', `${direction} requires project admin access`);
    try {
      const report = await runIssueArchive({
        projectId,
        direction,
        filter: parsed.data.filter,
        dryRun: parsed.data.dryRun === true,
        actor: restActor(c),
      });
      return c.json(report);
    } catch (err) {
      if (err instanceof IssueArchiveRefusedError) {
        throw new HTTPException(409, {
          message: err.message,
          cause: { code: err.code, details: err.report },
        });
      }
      throw err;
    }
  };
}

const validProjectId = zValidator('param', projectIdParamSchema, (r) => {
  if (!r.success) throw badRequest(z.flattenError(r.error));
});

issueArchiveRoutes.post('/:id/issues/archive', validProjectId, archiveHandler('archive'));
issueArchiveRoutes.post('/:id/issues/unarchive', validProjectId, archiveHandler('unarchive'));
