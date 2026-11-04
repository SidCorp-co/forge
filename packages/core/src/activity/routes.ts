// `GET /api/orgs/:orgId/activity`: what each project of the workspace works now and next, and
// `GET /api/orgs/:orgId/activity/:projectId/recent`: what one of them recorded last (ISS-951).

import { Hono } from 'hono';
import { z } from 'zod';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { legsTiming, type OrgActivityLegs, readOrgActivity } from './read.js';
import { projectOfOrg, readProjectRecent } from './recent.js';

const orgParam = z.object({ orgId: z.uuid() });
const recentParam = z.object({ orgId: z.uuid(), projectId: z.uuid() });

export const orgActivityRoutes = new Hono<{ Variables: AuthVars }>();
orgActivityRoutes.use('/:orgId/activity', requireAuth(), assertEmailVerified());
orgActivityRoutes.use('/:orgId/activity/*', requireAuth(), assertEmailVerified());

// org.read admits the caller to the org; each project's row is there only where the caller reads it
orgActivityRoutes.get(
  '/:orgId/activity',
  zValidator('param', orgParam, invalid('invalid path: /api/orgs/<org uuid>/activity')),
  requiresOnParam('org.read', 'orgId'),
  noQuery,
  async (c) => {
    const { orgId } = c.req.valid('param');
    const agency = c.get('agency');
    if (!agency)
      throw new Error('orgs/activity: a request reached its handler without an auth gate');
    const legs: OrgActivityLegs = new Map();
    const read = await readOrgActivity(orgId, { userId: c.get('userId'), agency }, new Date(), {
      legs,
    });
    // each row carries its project's issue text, so each passes that project's egress policy
    const started = performance.now();
    const projects = await Promise.all(
      read.projects.map((row) =>
        egressForRequest(agency, row.projectId, 'issue', row, `${row.name}'s activity`),
      ),
    );
    // each leg's milliseconds, beside the whole request's `db`/`app`/`total` (middleware/server-timing.ts),
    // so a reader whose token reads the route sees which leg a slow read waited on
    c.header(
      'Server-Timing',
      `${legsTiming(legs)}, egress;dur=${(performance.now() - started).toFixed(1)}`,
      { append: true },
    );
    return c.json({ ...read, projects });
  },
);

// the peek's Recent list, read when it is opened: a project of the org the caller reads, else absent
orgActivityRoutes.get(
  '/:orgId/activity/:projectId/recent',
  zValidator(
    'param',
    recentParam,
    invalid('invalid path: /api/orgs/<org uuid>/activity/<project uuid>/recent'),
  ),
  requiresOnParam('org.read', 'orgId'),
  noQuery,
  async (c) => {
    const { orgId, projectId } = c.req.valid('param');
    const agency = c.get('agency');
    if (!agency)
      throw new Error('orgs/activity/recent: a request reached its handler without an auth gate');
    const inOrg = await projectOfOrg(orgId, projectId);
    const visible = inOrg && (await loadVisibleProjectIds(c.get('userId'))).includes(projectId);
    if (!inOrg || !visible) {
      return c.json(
        {
          code: 'NOT_FOUND',
          error: `no project ${projectId} of this workspace that you can read: name one GET /api/orgs/${orgId}/activity lists`,
        },
        404,
      );
    }
    const recent = await readProjectRecent(projectId);
    return c.json(
      await egressForRequest(agency, projectId, 'issue', recent, `${inOrg}'s recent activity`),
    );
  },
);
