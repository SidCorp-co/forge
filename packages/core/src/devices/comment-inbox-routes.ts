/** What a project's issue threads owe a person a reply to, read by the box carrying its master on every sweep. */

import { Hono } from 'hono';
import { z } from 'zod';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { readOwedComments } from './comment-inbox.js';
import { assertDeviceBoundToProject } from './device-project.js';

export const deviceCommentInboxRoutes = new Hono<{ Variables: DeviceVars }>();

const querySchema = z.object({ projectId: z.uuid() });

deviceCommentInboxRoutes.get(
  '/me/comments/unanswered',
  requireDevice(),
  zValidator('query', querySchema, invalid('projectId is required and is a project uuid')),
  async (c) => {
    const { projectId } = c.req.valid('query');
    await assertDeviceBoundToProject(c.get('device').id, projectId);
    const { items, count } = await readOwedComments(projectId);
    return c.json({ projectId, items, count });
  },
);
