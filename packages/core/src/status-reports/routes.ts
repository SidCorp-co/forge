import {
  PROJECT_STATUS_DAYS_DEFAULT,
  PROJECT_STATUS_DAYS_MAX,
} from '@forge/contracts/project-status';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { notFound } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { markStatusReportRead } from '../notifications/index.js';
import { requireHeld } from '../permissions/index.js';
import {
  listStatusReports,
  readStatusReport,
  reportMeta,
  reportRow,
  storeStatusReport,
} from './store.js';

const projectParam = z.strictObject({ id: z.uuid() });
const reportParam = z.strictObject({ id: z.uuid(), reportId: z.uuid() });
const saveBody = z.strictObject({
  days: z.number().int().min(1).max(PROJECT_STATUS_DAYS_MAX).optional(),
});

const agencyOf = (agency: AuthVars['agency']) => {
  if (!agency)
    throw new Error('status reports: a request reached its handler without an auth gate');
  return agency;
};

export const statusReportRoutes = new Hono<{ Variables: AuthVars }>();
statusReportRoutes.use('/:id/status/reports', requireAuth(), assertEmailVerified());
statusReportRoutes.use('/:id/status/reports/*', requireAuth(), assertEmailVerified());

statusReportRoutes.get(
  '/:id/status/reports',
  zValidator(
    'param',
    projectParam,
    invalid('invalid path: /api/projects/<project>/status/reports'),
  ),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    requireHeld(await loadProjectAccess(projectId, c.get('userId')), 'project.read');
    return c.json({ reports: await listStatusReports(projectId) });
  },
);

statusReportRoutes.post(
  '/:id/status/reports',
  zValidator(
    'param',
    projectParam,
    invalid('invalid path: /api/projects/<project>/status/reports'),
  ),
  zValidator('json', saveBody, invalid(`invalid body: { days?: 1..${PROJECT_STATUS_DAYS_MAX} }`)),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write', 'saving a status report');
    const row = await storeStatusReport({
      projectId,
      access,
      agency: agencyOf(c.get('agency')),
      days: c.req.valid('json').days ?? PROJECT_STATUS_DAYS_DEFAULT,
      producer: { kind: 'person', userId },
    });
    return c.json(await reportMeta(row), 201);
  },
);

statusReportRoutes.get(
  '/:id/status/reports/:reportId',
  zValidator(
    'param',
    reportParam,
    invalid('invalid path: /api/projects/<project>/status/reports/<report id>'),
  ),
  async (c) => {
    const { id: projectId, reportId } = c.req.valid('param');
    requireHeld(await loadProjectAccess(projectId, c.get('userId')), 'project.read');
    const row = await reportRow(projectId, reportId);
    if (!row) throw notFound(`status report ${reportId} is not one of this project's reports`);
    const detail = await readStatusReport(row);
    return c.json(
      await egressForRequest(
        agencyOf(c.get('agency')),
        projectId,
        'issue',
        detail,
        'a stored status report',
      ),
    );
  },
);

statusReportRoutes.post(
  '/:id/status/reports/:reportId/read',
  zValidator(
    'param',
    reportParam,
    invalid('invalid path: /api/projects/<project>/status/reports/<report id>/read'),
  ),
  async (c) => {
    const { id: projectId, reportId } = c.req.valid('param');
    const userId = c.get('userId');
    requireHeld(await loadProjectAccess(projectId, userId), 'project.read');
    if (!(await reportRow(projectId, reportId))) {
      throw notFound(`status report ${reportId} is not one of this project's reports`);
    }
    return c.json({ read: await markStatusReportRead(userId, reportId) });
  },
);
