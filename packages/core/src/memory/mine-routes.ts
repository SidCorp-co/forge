/**
 * ISS-1034 — `GET /api/memory/mine`, `DELETE /api/memory/mine/:id`: what the
 * assistant remembered on the caller's behalf, and the way to take it back.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, can, projectResource, requireCan } from '../permissions/index.js';
import { deleteMine, findMine, listMine } from './mine-service.js';

const listQuerySchema = z.object({ projectId: z.uuid().optional() });

export const memoryMineRoutes = new Hono<{ Variables: AuthVars }>();
memoryMineRoutes.use('*', requireAuth(), assertEmailVerified());

memoryMineRoutes.get('/mine', zValidator('query', listQuerySchema), async (c) => {
  const { projectId } = c.req.valid('query');
  const userId = c.get('userId');
  const rows = await listMine(userId, { projectId });
  const readable = new Map<string, boolean>();
  const items = [];
  for (const row of rows) {
    let ok = readable.get(row.projectId);
    if (ok === undefined) {
      ok = await can(actorFor(userId), 'project.read', projectResource(row.projectId));
      readable.set(row.projectId, ok);
    }
    if (ok) items.push(row);
  }
  return c.json({ items });
});

memoryMineRoutes.delete('/mine/:id', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');
  const mine = await findMine(userId, id);
  if (mine) await requireCan(actorFor(userId), 'project.write', projectResource(mine.projectId));
  const removed = mine ? await deleteMine(userId, id) : false;
  if (!removed) {
    throw notFound('no note of yours has that id');
  }
  return c.body(null, 204);
});
