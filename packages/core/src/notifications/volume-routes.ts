// A project's notification volume by type (ISS-863), `GET /api/projects/:id/notifications/volume`,
// for a project reader: the measure the notify-only-to-act cut is judged by, before and after.

import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { notificationVolumeOf } from './read.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);
const volumeQuery = zValidator(
  'query',
  z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).strict(),
  invalid('invalid query: days is a whole number of days, 1 to 90 (default 7)'),
);

export const notificationVolumeRoutes = new Hono<{ Variables: AuthVars }>();
notificationVolumeRoutes.use('/:id/notifications/volume', requireAuth(), assertEmailVerified());

notificationVolumeRoutes.get('/:id/notifications/volume', projectParam, volumeQuery, async (c) => {
  const { id } = c.req.valid('param');
  const { days } = c.req.valid('query');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const until = new Date();
  const since = new Date(until.getTime() - days * DAY_MS);
  const types = await notificationVolumeOf(id, since);
  return c.json({
    projectId: id,
    since: since.toISOString(),
    until: until.toISOString(),
    records: types.reduce((n, t) => n + t.records, 0),
    deliveries: types.reduce((n, t) => n + t.deliveries, 0),
    types,
  });
});
