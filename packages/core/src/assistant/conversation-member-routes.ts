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

import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { resolveProjectHandle } from '../conversations/handles.js';
import {
  addableHandles,
  addablePeople,
  assertPersonReachesScope,
  personLabel,
  projectsNamed,
  settleShape,
} from '../conversations/membership.js';
import {
  addHandle,
  addPerson,
  listParticipants,
  removeParticipant,
} from '../conversations/participants.js';
import { derivedScope } from '../conversations/scope.js';
import { getConversation } from '../conversations/store.js';
import { conversationParticipants } from '../db/schema-conversations.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  mayChangeMembership,
  readableConversation,
  withMembershipLock,
} from './conversation-access.js';
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
  shape: string;
  canChangeMembership: boolean;
  participants: Awaited<ReturnType<typeof withDisplayNames>>;
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
  zValidator('query', projectQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');
    const scope = [projectId];
    const [people, handles] = await Promise.all([
      addablePeople(null, scope),
      addableHandles(null, userId, scope),
    ]);
    return c.json({ people: await namePeople(people), handles: await nameLostReaders(handles) });
  },
);

/**
 * Who this caller could still put in this room.
 */
conversationMemberRoutes.get(
  '/:id/candidates',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await readableConversation(id, userId);
    const scope = await derivedScope(id);
    const [people, handles] = await Promise.all([
      addablePeople(id, scope),
      addableHandles(id, userId, scope),
    ]);
    return c.json({ people: await namePeople(people), handles: await nameLostReaders(handles) });
  },
);

/**
 * Add a person: who reads the room changes, and nothing about what it can see does.
 */
conversationMemberRoutes.post(
  '/:id/people',
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
      await assertPersonReachesScope(joining, scope, tx);
      await addPerson({ conversationId: id, userId: joining, actorUserId: actor, tx });
      await settleShape(tx, id, {
        kind: 'person',
        label: await personLabel(tx, joining),
        verb: 'joined',
      });
    });
    return c.json(await membershipOf(id, actor), 201);
  },
);

/**
 * Add an agent: what the room can see changes, which is why this one moves the shape.
 */
conversationMemberRoutes.post(
  '/:id/handles',
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
      const handleUserId = userId ?? (await resolveProjectHandle(tx, projectId)).userId;
      await addHandle({ conversationId: id, handleUserId, projectId, actorUserId: actor, tx });
      await settleShape(tx, id);
    });
    return c.json(await membershipOf(id, actor), 201);
  },
);

/**
 * Take one member out, whichever kind it is.
 */
conversationMemberRoutes.delete(
  '/:id/participants/:participantId',
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
    return c.json(await membershipOf(id, actor));
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
