/**
 * `POST /api/projects/:id/requirements/:req/assistant` — the BA door's way in (ISS-58). It opens the
 * caller's room about one requirement, or hands back the one they already have; talking in it is
 * the ordinary web conversation transport (`POST /api/conversations/:id/messages` and its socket
 * events), which answers a requirement room through the BA persona and tool set.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { settleShape } from '../conversations/membership.js';
import { addPerson } from '../conversations/participants.js';
import { getConversation, openConversationIn } from '../conversations/store.js';
import { db } from '../db/client.js';
import { conversationParticipants, conversations } from '../db/schema-conversations.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requirementKey, rowIn } from '../requirements/read.js';

export const baDoorRoutes = new Hono<{ Variables: AuthVars }>();

baDoorRoutes.use('/:id/requirements/:req/assistant', requireAuth(), assertEmailVerified());

const param = zValidator(
  'param',
  z.object({ id: z.uuid(), req: z.string().trim().min(1).max(64) }),
  (r) => {
    if (!r.success)
      throw new HTTPException(400, {
        message: 'invalid path: a project uuid and a requirement uuid or key',
        cause: { code: 'BAD_REQUEST' },
      });
  },
);

async function roomOf(requirementId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, conversations.id),
        eq(conversationParticipants.kind, 'person'),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .where(
      and(
        eq(conversations.requirementId, requirementId),
        eq(conversations.adapter, 'web'),
        isNull(conversations.archivedAt),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  return row?.id ?? null;
}

baDoorRoutes.post('/:id/requirements/:req/assistant', param, async (c) => {
  const { id: projectId, req } = c.req.valid('param');
  const userId = c.get('userId');
  await assertProjectAccess(projectId, userId, 'member');
  const requirement = await rowIn(db, projectId, req);
  const existing = await roomOf(requirement.id, userId);
  if (existing) {
    return c.json({ conversation: await getConversation(existing), reused: true });
  }
  const conversation = await db.transaction(async (handle) => {
    const tx = handle as unknown as typeof db;
    const room = await openConversationIn(tx, {
      adapter: 'web',
      externalId: randomUUID(),
      shape: 'direct',
      projectId,
      title: `${requirementKey(requirement.reqSeq)} · BA assistant`,
      requirementId: requirement.id,
    });
    await addPerson({ conversationId: room.id, userId, actorUserId: userId, tx });
    await settleShape(tx, room.id);
    return (await getConversation(room.id, tx)) ?? room;
  });
  return c.json({ conversation, reused: false }, 201);
});
