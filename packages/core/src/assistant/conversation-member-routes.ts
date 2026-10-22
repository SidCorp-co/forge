// `/api/conversations/:id` — who is in a room, and changing it.
//
// The four doors `participants.ts` built and ISS-1001 guarded, reached at last
// (ISS-1011). It sits beside `conversation-routes.ts` rather than inside it for
// the same reason that file gives for sitting outside `conversations/`: this is
// the Forge UI's own adapter, and the store is kept transport-free.
//
// Every route here answers with the room's whole membership as it then stands —
// its people, its agents, its shape and the projects it is about, each named.
// A caller that had to refetch to learn what its own write did would render the
// room as it was for as long as the second request took, which is the moment a
// person is looking hardest at what they just changed.

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import {
  addableHandles,
  addablePeople,
  agentsBeyondReach,
  assertPersonReachesScope,
  personLabel,
  projectsNamed,
  roomOpeners,
  settleShape,
} from '../conversations/membership.js';
import {
  addHandle,
  addPerson,
  listParticipants,
  type ParticipantRow,
  removeParticipant,
} from '../conversations/participants.js';
import { derivedScope } from '../conversations/scope.js';
import { getConversation } from '../conversations/store.js';
import { type ConversationShape, conversationParticipants } from '../db/schema-conversations.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  assertMayStartRoom,
  mayChangeMembership,
  readableConversation,
  withMembershipLock,
} from './conversation-access.js';
import {
  addHandleToRoom,
  addPersonToRoom,
  candidatesBeforeRoom,
  candidatesForRoom,
  candidatesSchema,
  membershipSchema,
  openersSchema,
  removeFromRoom,
  roomOpenersRead,
} from './conversation-member-routes-reference.js';
import { nameLostReaders, namePeople, withDisplayNames } from './conversation-people.js';

const idParamSchema = z.object({ id: z.uuid() });
const projectQuerySchema = z.object({ projectId: z.uuid() }).strict();
const removeParamSchema = z.object({ id: z.uuid(), participantId: z.uuid() });
const addPersonSchema = z.object({ userId: z.uuid() }).strict();
const addHandleSchema = z.object({ projectId: z.uuid(), userId: z.uuid().optional() }).strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const conversationMemberRoutes = new Hono<{ Variables: AuthVars }>();
conversationMemberRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * A room's membership, as one answer.
 */
export async function membershipOf(
  conversationId: string,
  userId: string,
): Promise<{
  shape: ConversationShape;
  canChangeMembership: boolean;
  participants: Array<ParticipantRow & { displayName: string | null }>;
  scope: string[];
  scopeProjects: Awaited<ReturnType<typeof projectsNamed>>;
}> {
  const [row, participants, scope] = await Promise.all([
    getConversation(conversationId),
    listParticipants(conversationId),
    derivedScope(conversationId),
  ]);
  return {
    shape: row?.shape ?? 'direct',
    canChangeMembership: row ? await mayChangeMembership(row, userId) : false,
    participants: await withDisplayNames(participants),
    scope,
    scopeProjects: await projectsNamed(scope),
  };
}

/**
 * Who this caller could open a room WITH, before any room exists.
 */
conversationMemberRoutes.get(
  '/candidates',
  candidatesBeforeRoom,
  zValidator('query', projectQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');
    await assertMayStartRoom(projectId, userId);
    const scope = [projectId];
    const [people, handles, beyondReach] = await Promise.all([
      addablePeople(null, scope),
      addableHandles(null, userId, scope),
      agentsBeyondReach(userId, scope),
    ]);
    return c.json(
      answer(candidatesSchema, {
        // The opener is in the room by opening it, so they are not offered to themself (ISS-1229 r25).
        people: await namePeople(people.filter((p) => p.userId !== userId)),
        handles: await nameLostReaders(handles),
        beyondReach,
      }),
    );
  },
);

/**
 * Which projects this caller may open a room on, and whether each one's own agent can answer there.
 */
conversationMemberRoutes.get('/openers', roomOpenersRead, async (c) =>
  c.json(answer(openersSchema, { openers: await roomOpeners(c.get('userId')) })),
);

/**
 * Who this caller could still put in this room.
 */
conversationMemberRoutes.get(
  '/:id/candidates',
  candidatesForRoom,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await readableConversation(id, userId);
    const scope = await derivedScope(id);
    const [people, handles, beyondReach] = await Promise.all([
      addablePeople(id, scope),
      addableHandles(id, userId, scope),
      agentsBeyondReach(userId, scope),
    ]);
    return c.json(
      answer(candidatesSchema, {
        people: await namePeople(people),
        handles: await nameLostReaders(handles),
        beyondReach,
      }),
    );
  },
);

/**
 * Add a person: who reads the room changes, and nothing about what it can see does.
 */
conversationMemberRoutes.post(
  '/:id/people',
  addPersonToRoom,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', addPersonSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { userId: joining } = c.req.valid('json');
    const actor = c.get('userId');
    await withMembershipLock(id, actor, async (tx, _room, scope) => {
      await assertPersonReachesScope(id, joining, scope, tx);
      await addPerson({ conversationId: id, userId: joining, actorUserId: actor, tx });
      await settleShape(tx, id, {
        kind: 'person',
        label: await personLabel(tx, joining),
        verb: 'joined',
      });
    });
    return c.json(answer(membershipSchema, await membershipOf(id, actor)), 201);
  },
);

/**
 * Add an agent: what the room can see changes, which is why this one moves the shape.
 */
conversationMemberRoutes.post(
  '/:id/handles',
  addHandleToRoom,
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', addHandleSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { userId, projectId } = c.req.valid('json');
    const actor = c.get('userId');
    await withMembershipLock(id, actor, async (tx) => {
      await addHandle({
        conversationId: id,
        ...(userId ? { handleUserId: userId } : {}),
        projectId,
        actorUserId: actor,
        tx,
      });
      await settleShape(tx, id);
    });
    return c.json(answer(membershipSchema, await membershipOf(id, actor)), 201);
  },
);

/**
 * Take one member out, whichever kind it is.
 */
conversationMemberRoutes.delete(
  '/:id/participants/:participantId',
  removeFromRoom,
  zValidator('param', removeParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, participantId } = c.req.valid('param');
    const actor = c.get('userId');
    await withMembershipLock(id, actor, async (tx) => {
      const leaving = await participantLabel(tx, id, participantId);
      await removeParticipant({ conversationId: id, participantId, tx: tx as never });
      if (leaving) await settleShape(tx, id, { ...leaving, verb: 'left' });
    });
    return c.json(answer(membershipSchema, await membershipOf(id, actor)));
  },
);

/** Who a participant row is, for the line the room is told when they leave. */
async function participantLabel(
  tx: Parameters<typeof settleShape>[0],
  conversationId: string,
  participantId: string,
): Promise<{ kind: 'person' | 'handle'; label: string } | null> {
  const [row] = await tx
    .select({
      kind: conversationParticipants.kind,
      userId: conversationParticipants.userId,
      label: conversationParticipants.label,
      externalKey: conversationParticipants.externalKey,
    })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.id, participantId),
        eq(conversationParticipants.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.kind === 'handle')
    return { kind: 'handle', label: row.label ?? row.userId ?? participantId };
  const label = row.userId
    ? await personLabel(tx, row.userId)
    : (row.label ?? row.externalKey ?? participantId);
  return { kind: 'person', label };
}
