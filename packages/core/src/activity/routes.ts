// `GET /api/orgs/:orgId/activity`: what each project of the workspace works now and next (ISS-951).

import { Hono } from 'hono';
import { z } from 'zod';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { readOrgActivity } from './read.js';

const orgParam = z.object({ orgId: z.uuid() });

export const orgActivityRoutes = new Hono<{ Variables: AuthVars }>();
orgActivityRoutes.use('/:orgId/activity', requireAuth(), assertEmailVerified());

// org.read admits the caller to the org; each project's row is there only where the caller reads it
orgActivityRoutes.get(
  '/:orgId/activity',
  zValidator('param', orgParam, invalid('invalid path: /api/orgs/<org uuid>/activity')),
  requiresOnParam('org.read', 'orgId'),
  noQuery,
  async (c) => {
    const { orgId } = c.req.valid('param');
    const agency = c.get('agency');
    if (!agency) throw new Error('orgs/activity: a request reached its handler without an auth gate');
    const read = await readOrgActivity(orgId, { userId: c.get('userId'), agency });
    // each row carries its project's issue text, so each passes that project's egress policy
    const projects = await Promise.all(
      read.projects.map((row) =>
        egressForRequest(agency, row.projectId, 'issue', row, `${row.name}'s activity`),
      ),
    );
    return c.json({ ...read, projects });
  },
);
