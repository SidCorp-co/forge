// `POST /api/conversations/:id/decision-outcomes` — a decision card pressed under a chat reply tells
// the room, and the room is answered with the item read back (REQ-41 BC-24). Dev, 2026-10-21: the
// owner pressed a card, saw "✓ Sent", and the chat stood still with nothing saying what moved. The
// browser names only the decision, the item and whether its press went through
// (`decision-outcome.ts:answerPressedCard` writes the rest from what core reads).

import { DECISION_OUTCOME_SHAPE, decisionOutcomeRequestSchema } from '@forge/contracts/chat-decide';
import { Hono } from 'hono';
import { z } from 'zod';
import { writableConversation } from '../conversations/index.js';
import type { AuthVars } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { answerPressedCard } from './decision-outcome.js';

export const decisionOutcomeRoutes = new Hono<{ Variables: AuthVars }>();

decisionOutcomeRoutes.post(
  '/:id/decision-outcomes',
  zValidator('param', z.object({ id: z.uuid() })),
  strictBody(decisionOutcomeRequestSchema, DECISION_OUTCOME_SHAPE),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await writableConversation(id, userId);
    return c.json(await answerPressedCard(id, userId, c.req.valid('json')));
  },
);
