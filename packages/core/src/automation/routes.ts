import {
  AUTOMATION_FIRES_DEFAULT,
  AUTOMATION_FIRES_MAX,
} from '@forge/contracts/automation-standing';
import { Hono } from 'hono';
import { z } from 'zod';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { forbidden, idParamSchema, notFound } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import {
  automationViewerOf,
  readAutomationStanding,
  readFireDetail,
  readReportDetail,
  readScheduleDetail,
} from './read.js';

const scheduleParam = z.object({ id: z.uuid(), scheduleId: z.uuid() });
const fireParam = z.object({ id: z.uuid(), fireId: z.uuid() });
const reportParam = z.object({ id: z.uuid(), reportId: z.uuid() });
const firesQuery = z.strictObject({
  firesLimit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUTOMATION_FIRES_MAX)
    .default(AUTOMATION_FIRES_DEFAULT),
});
const noQuery = z.strictObject({});

export const automationRoutes = new Hono<{ Variables: AuthVars }>();
automationRoutes.use('/:id/automation/*', requireAuth(), assertEmailVerified());

async function viewerOf(projectId: string, userId: string) {
  const viewer = await automationViewerOf(projectId, userId);
  if (!viewer) throw forbidden('not a project member');
  return viewer;
}

automationRoutes.get(
  '/:id/automation/standing',
  zValidator(
    'param',
    idParamSchema,
    invalid('invalid path: /api/projects/<project uuid>/automation/standing'),
  ),
  zValidator('query', firesQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const viewer = await viewerOf(projectId, c.get('userId'));
    const standing = await readAutomationStanding(projectId, viewer, c.req.valid('query'));
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', standing, 'automation'),
    );
  },
);

automationRoutes.get(
  '/:id/automation/schedules/:scheduleId',
  zValidator(
    'param',
    scheduleParam,
    invalid('invalid path: /api/projects/<project uuid>/automation/schedules/<schedule uuid>'),
  ),
  zValidator('query', firesQuery),
  async (c) => {
    const { id: projectId, scheduleId } = c.req.valid('param');
    const viewer = await viewerOf(projectId, c.get('userId'));
    const detail = await readScheduleDetail(projectId, scheduleId, viewer, c.req.valid('query'));
    if (!detail) throw notFound(`schedule ${scheduleId} is not a schedule of this project`);
    return c.json(
      await egressForRequest(
        restActor(c).agency,
        projectId,
        'issue',
        detail,
        `schedule ${detail.schedule.name}`,
      ),
    );
  },
);

automationRoutes.get(
  '/:id/automation/fires/:fireId',
  zValidator(
    'param',
    fireParam,
    invalid('invalid path: /api/projects/<project uuid>/automation/fires/<fire uuid>'),
  ),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId, fireId } = c.req.valid('param');
    const viewer = await viewerOf(projectId, c.get('userId'));
    const detail = await readFireDetail(projectId, fireId, viewer);
    if (!detail) throw notFound(`fire ${fireId} is not a fire of a schedule of this project`);
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', detail, `fire ${fireId}`),
    );
  },
);

automationRoutes.get(
  '/:id/automation/reports/:reportId',
  zValidator(
    'param',
    reportParam,
    invalid('invalid path: /api/projects/<project uuid>/automation/reports/<report uuid>'),
  ),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId, reportId } = c.req.valid('param');
    const viewer = await viewerOf(projectId, c.get('userId'));
    const detail = await readReportDetail(projectId, reportId, viewer);
    if (!detail) throw notFound(`report ${reportId} is not an agent report of this project`);
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', detail, `report ${reportId}`),
    );
  },
);
