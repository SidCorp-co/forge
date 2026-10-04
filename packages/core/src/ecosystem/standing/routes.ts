import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../../lib/authz.js';
import { queryBadRequest } from '../../lib/query-strict.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { badRequest, forbidden } from '../../middleware/route-errors.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { slug } from '../../project-config/index.js';
import { readContractDetail, readContractStanding } from './read.js';

const projectParam = z.object({ id: z.uuid() });
const contractParam = z.object({ id: z.uuid(), provider: slug(), contract: slug() });
const noQuery = z.strictObject({});

export const contractStandingRoutes = new Hono<{ Variables: AuthVars }>();
contractStandingRoutes.use('/:id/contract-standing', requireAuth(), assertEmailVerified());
contractStandingRoutes.use('/:id/contract-standing/*', requireAuth(), assertEmailVerified());

const query = zValidator('query', noQuery, (r) => {
  if (!r.success) throw queryBadRequest(noQuery, r.error);
});

async function member(projectId: string, userId: string | null): Promise<void> {
  const access = await loadProjectAccess(projectId, userId);
  if (!access.role) throw forbidden('not a project member');
}

contractStandingRoutes.get(
  '/:id/contract-standing',
  zValidator('param', projectParam, (r) => {
    if (!r.success)
      throw badRequest('invalid path: /api/projects/<project uuid>/contract-standing');
  }),
  query,
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await member(id, userId);
    return c.json(await readContractStanding(id, userId));
  },
);

contractStandingRoutes.get(
  '/:id/contract-standing/:provider/:contract',
  zValidator('param', contractParam, (r) => {
    if (!r.success) {
      throw badRequest(
        'invalid path: /api/projects/<project uuid>/contract-standing/<provider slug>/<publication slug>',
      );
    }
  }),
  query,
  async (c) => {
    const { id, provider, contract } = c.req.valid('param');
    const userId = c.get('userId');
    await member(id, userId);
    return c.json(await readContractDetail(id, userId, { provider, contract }));
  },
);
