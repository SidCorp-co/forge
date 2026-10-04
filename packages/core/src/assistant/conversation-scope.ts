import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { refuseConversation } from '../conversations/refusals.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readableConversation } from './conversation-access.js';
import { homeIsEcosystemMember } from './read.js';
import { pinConversation, unpinConversation } from './service.js';

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
  if (await homeIsEcosystemMember(homeProjectId, scope.ecosystemId)) return scope.ecosystemId;
  throw refuseConversation(
    'ECOSYSTEM_NOT_MEMBER',
    `project ${homeProjectId} is not an active member of ecosystem ${scope.ecosystemId}, so a chat opened under it cannot read at that ecosystem's scope — open it under a member project, or at project scope`,
    '/scope/ecosystemId',
  );
}

export const scopeIsFixed = (id: string) =>
  refuseConversation(
    'CONVERSATION_SCOPE_FIXED',
    `conversation ${id}'s scope was set when it was opened and never changes — open another conversation at the scope you want`,
    '/scope',
  );

export const conversationPinRoutes = new Hono<{ Variables: AuthVars }>();

const idParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success)
    throw new HTTPException(400, {
      message: 'Invalid input',
      cause: { code: 'BAD_REQUEST', details: r.error },
    });
});

conversationPinRoutes.put('/:id/pin', idParam, async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');
  await readableConversation(id, userId);
  await pinConversation(userId, id);
  return c.json({ conversationId: id, pinned: true });
});

conversationPinRoutes.delete('/:id/pin', idParam, async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');
  await readableConversation(id, userId);
  await unpinConversation(userId, id);
  return c.json({ conversationId: id, pinned: false });
});
