// `GET /api/projects/:id/pm/snapshot`, the project digest the forge CLI's `forge_project_pm` reads.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readPmSnapshot } from './snapshot-read.js';

const paramSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

async function assertMember(projectId: string, userId: string): Promise<void> {
  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.read');
}

export const projectSnapshotRoutes = new Hono<{ Variables: AuthVars }>();
projectSnapshotRoutes.use('/:id/pm/snapshot', requireAuth(), assertEmailVerified());

projectSnapshotRoutes.get(
  '/:id/pm/snapshot',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    await assertMember(id, c.get('userId'));
    return c.json(await readPmSnapshot(id));
  },
);
