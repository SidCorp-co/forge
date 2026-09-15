/**
 * ISS-1034 — `GET /api/memory/mine`, `DELETE /api/memory/mine/:id`: what the
 * assistant remembered on the caller's behalf, and the way to take it back.
 */
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { deleteMine, listMine } from './mine-service.js';

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
    const items = await listMine(c.get('userId'), { projectId });
    return c.json({ items });
  },
);

// cm:guard 404 and not 204 when the row is not the caller's, unlike the sibling `DELETE /:id`: that route hides whether an id exists in a project the caller cannot see, while this one answers a person about THEIR notes, and a silent 204 over somebody else's row would tell them it was gone when it stands (ISS-1034 criterion 30).
memoryMineRoutes.delete(
  '/mine/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const removed = await deleteMine(c.get('userId'), id);
    if (!removed) {
      throw new HTTPException(404, {
        message: 'no note of yours has that id',
        cause: { code: 'NOT_FOUND' },
      });
    }
    return c.body(null, 204);
  },
);
