/** Which returned designs owe a project's master a revision, read by the box carrying it on every sweep. */

import { Hono } from 'hono';
import { z } from 'zod';
import { assertDeviceBoundToProject } from '../devices/index.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { owedDesignRevisions } from './owed-designs.js';

export const deviceDesignInboxRoutes = new Hono<{ Variables: DeviceVars }>();

const querySchema = z.object({ projectId: z.uuid() });

deviceDesignInboxRoutes.get(
  '/me/designs/owed',
  requireDevice(),
  zValidator('query', querySchema, invalid('projectId is required and is a project uuid')),
  async (c) => {
    const { projectId } = c.req.valid('query');
    await assertDeviceBoundToProject(c.get('device').id, projectId);
    const items = await owedDesignRevisions(projectId);
    return c.json({ projectId, items, count: items.length });
  },
);
