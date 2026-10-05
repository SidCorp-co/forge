/** What a project's agreed requirements owe its master, read by the box carrying it on every sweep. */

import { Hono } from 'hono';
import { z } from 'zod';
import { assertDeviceBoundToProject } from '../devices/index.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { owedBreakdowns } from './owed-breakdowns.js';

export const deviceRequirementInboxRoutes = new Hono<{ Variables: DeviceVars }>();

const querySchema = z.object({ projectId: z.uuid() });

deviceRequirementInboxRoutes.get(
  '/me/requirements/owed',
  requireDevice(),
  zValidator('query', querySchema, invalid('projectId is required and is a project uuid')),
  async (c) => {
    const { projectId } = c.req.valid('query');
    await assertDeviceBoundToProject(c.get('device').id, projectId);
    const items = await owedBreakdowns(projectId);
    return c.json({ projectId, items, count: items.length });
  },
);
