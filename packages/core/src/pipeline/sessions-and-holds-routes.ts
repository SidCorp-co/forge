import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { assertRoleFor, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { readSessionsAndHolds, type SessionsAndHolds } from './sessions-and-holds.js';
import {
  paramSchema,
  readProjectSessionsAndHolds,
  sessionsAndHoldsSchema,
} from './sessions-and-holds-routes-reference.js';

/** True only where each type is assignable to the other: a key either side has alone makes it false. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The reference declares exactly what the reader answers, so a field added to either alone fails
 *  `tsc` here rather than reaching the published shape late (ISS-1228 round 12). */
const referenceIsTheReading: Same<z.input<typeof sessionsAndHoldsSchema>, SessionsAndHolds> = true;
void referenceIsTheReading;

/** Mounted at `/api/projects`, so the route is `/api/projects/:id/sessions-and-holds`. */
export const sessionsAndHoldsRoutes = new Hono<{ Variables: AuthVars }>();
sessionsAndHoldsRoutes.use('/:id/sessions-and-holds', requireAuth(), assertEmailVerified());

sessionsAndHoldsRoutes.get(
  '/:id/sessions-and-holds',
  readProjectSessionsAndHolds,
  zValidator('param', paramSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    assertRoleFor(access, 'viewer', 'read its sessions and holds');
    return c.json(answer(sessionsAndHoldsSchema, await readSessionsAndHolds(id)));
  },
);
