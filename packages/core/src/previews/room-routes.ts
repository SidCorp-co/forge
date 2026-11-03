// The POC room REST surface (`@forge/contracts/poc-room:ROOM_ROUTES`, REQ-44): a signed-in project
// member opens, reads, joins, asks, settles items in, settles and abandons a room. Each route
// validates, calls one service function and answers.

import {
  abandonRoomRequestSchema,
  openRoomRequestSchema,
  ROOM_LIMITS,
  roomAskRequestSchema,
  roomEnvelopeSchema,
  roomListSchema,
  settleItemRequestSchema,
  settleRoomRequestSchema,
} from '@forge/contracts/poc-room';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresByRule, requiresOnResolved } from '../permissions/index.js';
import type { PreviewActor } from './access.js';
import { settleRoom } from './room-settle.js';
import {
  abandonRoom,
  askRoom,
  joinRoom,
  listRooms,
  openRoom,
  readRoom,
  settleItem,
  unsettleItem,
} from './rooms.js';

const actorOf = (c: { get(key: 'userId'): string; get(key: 'agency'): AuthVars['agency'] }) => {
  const agency = c.get('agency');
  if (!agency) throw new Error('poc-rooms: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency } satisfies PreviewActor;
};

const roomParam = z.strictObject({ id: z.uuid() });
const itemParam = z.strictObject({ id: z.uuid(), itemId: z.uuid() });
const PATH = invalid('invalid path: /api/rooms/<room id>');
const envelope = (room: unknown) => roomEnvelopeSchema.parse({ room });
// each act loads the room first and checks the declared permission on its project
// (rooms.ts:roomAccess), so a stranger is still told ROOM_NOT_FOUND and a reader ROOM_FORBIDDEN
const ON_ROOM = 'the project of the POC room the path names';

/** A project's rooms, under `/api/projects`. */
export const projectRoomRoutes = new Hono<{ Variables: AuthVars }>();
projectRoomRoutes.use('/:id/rooms', requireAuth(), assertEmailVerified());

projectRoomRoutes.post(
  '/:id/rooms',
  zValidator('param', roomParam, invalid('invalid path: /api/projects/<project id>/rooms')),
  requiresByRule(
    'previews/rooms.ts:openRoom',
    "the idea preview's own rule (openIdeaPreview): the subject, the site and the writer, each refused by name",
  ),
  zValidator(
    'json',
    openRoomRequestSchema,
    invalid('invalid body: { about: REQ-n | FB-n, brief: what to build first }'),
  ),
  async (c) =>
    c.json(envelope(await openRoom(c.req.valid('param').id, c.req.valid('json'), actorOf(c))), 201),
);

projectRoomRoutes.get(
  '/:id/rooms',
  zValidator('param', roomParam, invalid('invalid path: /api/projects/<project id>/rooms')),
  requiresByRule(
    'previews/rooms.ts:listRooms',
    'any role on the project; anyone else is answered ROOM_NOT_FOUND, never told the project exists',
  ),
  noQuery,
  async (c) =>
    c.json(roomListSchema.parse({ rooms: await listRooms(c.req.valid('param').id, actorOf(c)) })),
);

/** One room, under `/api/rooms`. */
export const roomRoutes = new Hono<{ Variables: AuthVars }>();
for (const at of [
  '/:id',
  '/:id/join',
  '/:id/asks',
  '/:id/items',
  '/:id/items/:itemId',
  '/:id/settle',
  '/:id/abandon',
]) {
  roomRoutes.use(at, requireAuth(), assertEmailVerified());
}

roomRoutes.get(
  '/:id',
  zValidator('param', roomParam, PATH),
  noQuery,
  requiresOnResolved('project.read', ON_ROOM),
  async (c) => c.json(envelope(await readRoom(c.req.valid('param').id, actorOf(c)))),
);

roomRoutes.post(
  '/:id/join',
  zValidator('param', roomParam, PATH),
  requiresOnResolved('project.read', ON_ROOM),
  async (c) => c.json(envelope(await joinRoom(c.req.valid('param').id, actorOf(c)))),
);

roomRoutes.post(
  '/:id/asks',
  zValidator('param', roomParam, PATH),
  zValidator(
    'json',
    roomAskRequestSchema,
    invalid(`invalid body: { text: 1..${ROOM_LIMITS.ask} characters }`),
  ),
  requiresOnResolved('project.write', ON_ROOM),
  async (c) =>
    c.json(
      envelope(await askRoom(c.req.valid('param').id, actorOf(c), c.req.valid('json').text)),
      202,
    ),
);

roomRoutes.post(
  '/:id/items',
  zValidator('param', roomParam, PATH),
  zValidator(
    'json',
    settleItemRequestSchema,
    invalid(`invalid body: { turnId, text?: 1..${ROOM_LIMITS.item} characters }`),
  ),
  requiresOnResolved('project.write', ON_ROOM),
  async (c) =>
    c.json(
      envelope(await settleItem(c.req.valid('param').id, actorOf(c), c.req.valid('json'))),
      201,
    ),
);

roomRoutes.delete(
  '/:id/items/:itemId',
  zValidator('param', itemParam, invalid('invalid path: /api/rooms/<room id>/items/<item id>')),
  requiresOnResolved('project.write', ON_ROOM),
  async (c) => {
    const { id, itemId } = c.req.valid('param');
    return c.json(envelope(await unsettleItem(id, itemId, actorOf(c))));
  },
);

roomRoutes.post(
  '/:id/settle',
  zValidator('param', roomParam, PATH),
  zValidator(
    'json',
    settleRoomRequestSchema,
    invalid(
      "invalid body: { alt: what the page shows, snapshot: [rrweb's Meta event, then its FullSnapshot event] }",
      'PREVIEW_KEEP_SNAPSHOT_INVALID',
    ),
  ),
  requiresOnResolved('project.write', ON_ROOM),
  async (c) =>
    c.json(
      envelope(await settleRoom(c.req.valid('param').id, c.req.valid('json'), actorOf(c))),
      202,
    ),
);

roomRoutes.post(
  '/:id/abandon',
  zValidator('param', roomParam, PATH),
  zValidator('json', abandonRoomRequestSchema, invalid('invalid body: { reason?: string }')),
  requiresOnResolved('project.write', ON_ROOM),
  async (c) =>
    c.json(
      envelope(await abandonRoom(c.req.valid('param').id, actorOf(c), c.req.valid('json').reason)),
    ),
);
