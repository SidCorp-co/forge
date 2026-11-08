// What a room's agent works under, read by the binding's owner project (REQ-92 BC-2, ISS-1118): the
// block its binding holds for the room (the owner's brief), the grants it acts on, and the routes its
// channel record sends a question by, each with when it last changed. A grant is shown by name: a
// declared read by its name and summary, never its argv, and no secret is held here to show, since a
// binding's secrets live on its connection, sealed.

import type { SupportGrants } from '@forge/contracts/support';
import type { Hono } from 'hono';
import { z } from 'zod';
import { findBindingWithConnectionById } from '../integrations/index.js';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requireDeclaredOn, requiresOnParam } from '../permissions/index.js';
import { channelViewOf } from './channel-read.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { roomById } from './store.js';

const roomParam = zValidator(
  'param',
  z.object({ id: z.uuid(), roomId: z.uuid() }),
  invalid('invalid path: a project uuid and a support room uuid'),
);

/** The grants as a reader is shown them: every one by name, a read without the program it runs. */
function namedGrants(g: SupportGrants) {
  const { reads, ...rest } = g;
  return {
    ...rest,
    ...(reads ? { reads: reads.map((r) => ({ name: r.name, summary: r.summary })) } : {}),
  };
}

/** The room's brief, grants and routes in force; null for a room the project does not hold. */
export async function roomBriefOf(viewer: string, projectId: string, roomId: string) {
  await requireDeclaredOn(projectId, viewer, 'project.read');
  const room = await roomById(roomId);
  if (!room || room.projectId !== projectId) return null;
  const [pair, config, channel] = await Promise.all([
    findBindingWithConnectionById(room.bindingId),
    supportConfigOf(room),
    channelViewOf(viewer, projectId, room.rid),
  ]);
  const { grants: _named, ...brief } = config ?? {};
  const changed = (channel?.memberRows ?? []).map((m) => m.updatedAt).sort();
  return {
    room: { id: room.id, rid: room.rid, kind: room.kind },
    // the brief and the grants are one block of the binding: they change with its revision
    binding: pair
      ? {
          id: pair.binding.id,
          revision: pair.binding.revision,
          changedAt: pair.binding.updatedAt.toISOString(),
        }
      : null,
    brief: config ? brief : null,
    grants: config ? namedGrants(grantsOf(config)) : null,
    routes: channel?.routes ?? [],
    // a route follows the members it goes to: it last changed when the newest of them did
    routesChangedAt: changed.at(-1) ?? null,
  };
}

/** `GET /:id/support/rooms/:roomId/brief`. */
export function mountRoomBriefRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.get(
    '/:id/support/rooms/:roomId/brief',
    roomParam,
    requiresOnParam('project.read', 'id'),
    noQuery,
    async (c) => {
      const { id, roomId } = c.req.valid('param');
      const brief = await roomBriefOf(c.get('userId'), id, roomId);
      if (!brief) {
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
      return c.json({ brief });
    },
  );
}
