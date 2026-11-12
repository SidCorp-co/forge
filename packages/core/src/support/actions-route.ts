// A room's actions as the project reads them (REQ-75 BC-18): the newest inside an optional window,
// oldest first, and whether the limit cut it (ISS-1215). The daily review reads its day by the window.

import type { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { supportActionsOf } from './read.js';

const roomParam = zValidator(
  'param',
  z.object({ id: z.uuid(), roomId: z.uuid() }),
  invalid('invalid path: a project uuid and a support room uuid'),
);

// `since` inclusive, `until` exclusive, each an ISO timestamp with its offset; one before the other.
const actionsWindow = z
  .strictObject({
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.since || !q.until || Date.parse(q.since) < Date.parse(q.until), {
    path: ['until'],
    message: '`until` must come after `since`',
  });

export function mountActionsRoute(routes: Hono<{ Variables: AuthVars }>): void {
  routes.get(
    '/:id/support/rooms/:roomId/actions',
    roomParam,
    requiresOnParam('project.read', 'id'),
    zValidator(
      'query',
      actionsWindow,
      invalid('invalid query: { since?: ISO timestamp with offset, until?: one after since }'),
    ),
    async (c) => {
      const { id, roomId } = c.req.valid('param');
      const q = c.req.valid('query');
      const read = await supportActionsOf(c.get('userId'), id, roomId, {
        since: q.since ? new Date(q.since) : undefined,
        until: q.until ? new Date(q.until) : undefined,
      });
      if (!read) {
        return refused(
          c,
          [
            {
              code: 'SUPPORT_ROOM_UNKNOWN',
              path: '/roomId',
              detail: `this project holds no support room ${roomId}`,
            },
          ],
          'SUPPORT_REFUSED',
        );
      }
      return c.json(read);
    },
  );
}
