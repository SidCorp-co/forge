import type { ContractRequestListResponse } from '@forge/contracts/contract-waits';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { listContractRequests } from './read.js';
import { requireCan } from '../../permissions/index.js';

export const contractRequestRoutes = new Hono<{ Variables: AuthVars }>();

contractRequestRoutes.use('/:id/contract-requests', requireAuth(), assertEmailVerified());

const projectParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) {
    throw new HTTPException(400, {
      message: 'invalid path: the project id is a uuid',
      cause: { code: 'BAD_REQUEST' },
    });
  }
});

contractRequestRoutes.get('/:id/contract-requests', projectParam, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan({ userId: c.get('userId') }, 'project.read', id);
  const body: ContractRequestListResponse = { requests: await listContractRequests(id) };
  return c.json(body);
});
