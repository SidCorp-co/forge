import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { conversationPins } from '../db/schema-conversations.js';
import { activeEcosystemIdsOf } from '../ecosystem/store.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readableConversation } from './conversation-access.js';

export const conversationScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z.object({ kind: z.literal('ecosystem'), ecosystemId: z.uuid() }).strict(),
]);
export type ConversationScope = z.infer<typeof conversationScopeSchema>;

// cm:guard the home project is where the turn's authority comes from, so an ecosystem scope is taken only for an ecosystem the home project is an active member of; anything else would let a chat read as a side it is not
export async function ecosystemOfScope(
  homeProjectId: string,
  scope: ConversationScope | undefined,
): Promise<string | null> {
  if (!scope || scope.kind === 'project') return null;
  const active = await activeEcosystemIdsOf(db, [homeProjectId]);
  if (active.some((m) => m.ecosystemId === scope.ecosystemId)) return scope.ecosystemId;
  throw new HTTPException(409, {
    message: `project ${homeProjectId} is not an active member of ecosystem ${scope.ecosystemId}, so a chat opened under it cannot read at that ecosystem's scope — open it under a member project, or at project scope`,
    cause: {
      code: 'ECOSYSTEM_NOT_MEMBER',
      details: { projectId: homeProjectId, ecosystemId: scope.ecosystemId },
    },
  });
}

export const scopeIsFixed = (id: string) =>
  new HTTPException(409, {
    message: `conversation ${id}'s scope was set when it was opened and never changes — open another conversation at the scope you want`,
    cause: { code: 'CONVERSATION_SCOPE_FIXED' },
  });

export async function pinnedBy(userId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: conversationPins.conversationId })
    .from(conversationPins)
    .where(
      and(eq(conversationPins.userId, userId), inArray(conversationPins.conversationId, [...ids])),
    );
  return new Set(rows.map((r) => r.id));
}

export const conversationPinRoutes = new Hono<{ Variables: AuthVars }>();

const idParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success)
    throw new HTTPException(400, {
      message: 'Invalid input',
      cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
    });
});

conversationPinRoutes.put('/:id/pin', idParam, async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');
  await readableConversation(id, userId);
  await db.insert(conversationPins).values({ userId, conversationId: id }).onConflictDoNothing();
  return c.json({ conversationId: id, pinned: true });
});

conversationPinRoutes.delete('/:id/pin', idParam, async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');
  await readableConversation(id, userId);
  await db
    .delete(conversationPins)
    .where(and(eq(conversationPins.userId, userId), eq(conversationPins.conversationId, id)));
  return c.json({ conversationId: id, pinned: false });
});
