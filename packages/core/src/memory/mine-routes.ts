/**
 * ISS-1034 — `GET /api/memory/mine`, `DELETE /api/memory/mine/:id`: what the
 * assistant remembered on the caller's behalf, and the way to take it back.
 */
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectAccess, effectiveProjectRole } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { deleteMine, findMine, listMine } from './mine-service.js';

const listQuerySchema = z.object({ projectId: z.uuid().optional() });
const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const memoryMineRoutes = new Hono<{ Variables: AuthVars }>();
memoryMineRoutes.use('*', requireAuth(), assertEmailVerified());

memoryMineRoutes.get(
  '/mine',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');
    const rows = await listMine(userId, { projectId });
    const readable = new Map<string, boolean>();
    const items = [];
    for (const row of rows) {
      let ok = readable.get(row.projectId);
      if (ok === undefined) {
        ok = (await effectiveProjectRole(userId, row.projectId))?.role !== undefined;
        readable.set(row.projectId, ok);
      }
      if (ok) items.push(row);
    }
    return c.json({ items });
  },
);

memoryMineRoutes.delete(
  '/mine/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    const mine = await findMine(userId, id);
    if (mine) await assertProjectAccess(mine.projectId, userId);
    const removed = mine ? await deleteMine(userId, id) : false;
    if (!removed) {
      throw new HTTPException(404, {
        message: 'no note of yours has that id',
        cause: { code: 'NOT_FOUND' },
      });
    }
    return c.body(null, 204);
  },
);
