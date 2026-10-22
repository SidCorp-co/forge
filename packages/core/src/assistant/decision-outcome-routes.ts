// `POST /api/conversations/:id/decision-outcomes` — a decision card pressed under a chat reply tells
// the room, and the room is answered with the item read back (REQ-41 BC-24). Dev, 2026-10-21: the
// owner pressed a card, saw "✓ Sent", and the chat stood still with nothing saying what moved. The
// follow-up is written here from what core reads now, never from what the browser says: the browser
// names only the decision, the item and whether its press went through.

import { DECISION_OUTCOME_SHAPE, decisionOutcomeRequestSchema } from '@forge/contracts/chat-decide';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { writableConversation } from '../conversations/index.js';
import { db } from '../db/client.js';
import { conversationWindows } from '../db/schema-conversations.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { postServiceAnswer } from './conversation-adapter.js';
import { itemStateOf, stateSentence } from './item-state.js';

export const decisionOutcomeRoutes = new Hono<{ Variables: AuthVars }>();

const refuse = refuser<'DECISION_OUTCOME_NO_PROJECT'>('DECISION_OUTCOME_NO_PROJECT');

/** The project the room's newest turn answered about: the one its decision cards were read from. */
async function answeringProject(conversationId: string): Promise<string> {
  const [w] = await db
    .select({ projectId: conversationWindows.projectId })
    .from(conversationWindows)
    .where(eq(conversationWindows.conversationId, conversationId))
    .orderBy(desc(conversationWindows.openedAt))
    .limit(1);
  if (!w) {
    throw refuse(
      'DECISION_OUTCOME_NO_PROJECT',
      `conversation ${conversationId} has had no turn, so no decision card was drawn in it to report on`,
    );
  }
  return w.projectId;
}

/** The follow-up a pressed card is answered with: what the press did, as the item now reads. */
export function outcomeSentence(ok: boolean, key: string | null, read: string | null): string {
  if (!key) {
    return ok
      ? 'Your answer was sent. It opens no item, so there is no state to read back.'
      : 'Your answer did not go through; the card says why, and the decision still waits on you.';
  }
  if (!read) {
    return ok
      ? `Your answer on ${key} was sent, and ${key} reads as no item of this project now.`
      : `Your answer on ${key} did not go through, and ${key} reads as no item of this project now.`;
  }
  return ok
    ? `Your answer on ${key} was sent. ${read}`
    : `Your answer on ${key} did not go through; the card says why. ${read}`;
}

decisionOutcomeRoutes.post(
  '/:id/decision-outcomes',
  zValidator('param', z.object({ id: z.uuid() })),
  strictBody(decisionOutcomeRequestSchema, DECISION_OUTCOME_SHAPE),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await writableConversation(id, userId);
    const projectId = await answeringProject(id);
    await loadProjectAccess(projectId, userId);
    const body = c.req.valid('json');
    const key = body.opens?.key.toUpperCase() ?? null;
    const state = body.opens
      ? await itemStateOf(projectId, { kind: body.opens.kind, key: body.opens.key })
      : null;
    const content = outcomeSentence(body.ok, key, state ? stateSentence(state) : null);
    await postServiceAnswer({
      conversationId: id,
      projectId,
      askerUserId: userId,
      content,
      blocks: [],
    });
    return c.json({ content, state });
  },
);
