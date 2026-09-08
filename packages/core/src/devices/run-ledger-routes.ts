/**
 * The read surface: which agent sessions the fleet is running, off the box.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { readProjectRunSessions } from './run-ledger.js';

const paramsSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = () =>
  new HTTPException(403, { message: 'not a project member', cause: { code: 'FORBIDDEN' } });

/** Mounted at `/api/projects`, so the route is `/api/projects/:id/run-sessions`. */
export const runLedgerRoutes = new Hono<{ Variables: AuthVars }>();
runLedgerRoutes.use('/:id/run-sessions', requireAuth(), assertEmailVerified());

// cm:guard a PROJECT-member read and never the device's owner alone. The whole point of ISS-934 is that a box's registry is readable by people who are not on that box; scoping it to the pairer would leave it as machine-local as `/run/user/<uid>/cc-socks` was.
runLedgerRoutes.get(
  '/:id/run-sessions',
  zValidator('param', paramsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    if (!access.role) throw forbidden();
    const items = await readProjectRunSessions(id);
    return c.json({ items, count: items.length });
  },
);
