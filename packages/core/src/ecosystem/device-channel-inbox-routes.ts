/** What a project's channel owes a reply to, and the builder runs it owes (ISS-39), read by the box carrying its master on every sweep (ISS-38). */

import { Hono } from 'hono';
import { z } from 'zod';
import { assertDeviceBoundToProject } from '../devices/index.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { unanswered } from './channel-read.js';
import { unansweredView } from './channel-view.js';
import { openRunsOf } from './link-service.js';

export const deviceChannelInboxRoutes = new Hono<{ Variables: DeviceVars }>();

const querySchema = z.object({ projectId: z.uuid() });

deviceChannelInboxRoutes.get(
  '/me/channel/unanswered',
  requireDevice(),
  zValidator('query', querySchema, (r) => {
    if (!r.success) throw badRequest('projectId is required and is a project uuid');
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    await assertDeviceBoundToProject(c.get('device').id, projectId);
    const items = unansweredView(await unanswered(projectId));
    const builderRuns = await openRunsOf(projectId);
    return c.json({ projectId, items, count: items.length, builderRuns });
  },
);
