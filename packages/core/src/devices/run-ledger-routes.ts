/**
 * The read surface: which agent sessions the fleet is running, off the box.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readProjectRunSessions } from './run-ledger.js';

const paramsSchema = z.object({ id: z.uuid() });

/** Mounted at `/api/projects`, so the route is `/api/projects/:id/run-sessions`. */
export const runLedgerRoutes = new Hono<{ Variables: AuthVars }>();
runLedgerRoutes.use('/:id/run-sessions', requireAuth(), assertEmailVerified());

runLedgerRoutes.get(
  '/:id/run-sessions',
  zValidator('param', paramsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    if (!access.role) throw forbidden('not a project member');
    const items = await readProjectRunSessions(id);
    return c.json({ items, count: items.length });
  },
);
