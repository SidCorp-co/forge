// Naming a room's report thread (ISS-1224): a person's own thread for the room's reports, such as the
// owner's or the BA's, takes a master's post naming no thread and core's room-down line from then on,
// in place of the thread Forge opens itself (`report-thread.ts`). The thread is admitted as a master's
// post into it would be (`master-post.ts:roomOfThread`): one of that room, which in a room the
// product's users read a member wrote in. Any other is refused by name, and nothing is saved.

import { supportReportThreadRequestSchema } from '@forge/contracts/support-channel';
import type { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan, requiresOnParam } from '../permissions/index.js';
import { postableRoomsOf, roomOfThread } from './master-post.js';
import { no, type Outcome } from './outcome.js';
import { nameReportThread } from './report-thread.js';

const roomParam = zValidator(
  'param',
  z.object({ id: z.uuid(), roomId: z.uuid() }),
  invalid('invalid path: a project uuid and a support room uuid'),
);

type Named = { roomId: string; rid: string; reportThread: string; reportThreadBy: 'person' };

/** Name `thread` the room's report thread, where it is one of that room's the room admits. */
async function setReportThread(
  actor: { userId: string; projectId: string },
  roomId: string,
  thread: string,
): Promise<Outcome<Named>> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  const rooms = await postableRoomsOf(actor.projectId);
  const at = rooms.find((r) => r.room.id === roomId);
  if (!at) {
    return no(
      'SUPPORT_ROOM_UNKNOWN',
      '/roomId',
      `this project's bindings answer no room ${roomId} now (GET /api/projects/${actor.projectId}/support/rooms lists them). Nothing was saved.`,
    );
  }
  const found = await roomOfThread([at], at.room.rid, thread, 'Nothing was saved.');
  if (!found.ok) return found;
  await nameReportThread(at.room.id, thread);
  return {
    ok: true,
    value: { roomId: at.room.id, rid: at.room.rid, reportThread: thread, reportThreadBy: 'person' },
  };
}

/** `PUT /:id/support/rooms/:roomId/report-thread`. */
export function mountReportThreadRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.put(
    '/:id/support/rooms/:roomId/report-thread',
    roomParam,
    requiresOnParam('project.write', 'id'),
    strictBody(supportReportThreadRequestSchema, '{ thread }'),
    async (c) => {
      const { id, roomId } = c.req.valid('param');
      const out = await setReportThread(
        { userId: c.get('userId'), projectId: id },
        roomId,
        c.req.valid('json').thread,
      );
      if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
      return c.json(out.value);
    },
  );
}
