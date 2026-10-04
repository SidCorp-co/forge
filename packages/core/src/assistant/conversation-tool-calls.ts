import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readableConversation } from './conversation-access.js';
import { readRoomToolCalls } from './read.js';

export const conversationToolCallRoutes = new Hono<{ Variables: AuthVars }>();

conversationToolCallRoutes.get(
  '/:id/tool-calls',
  zValidator('param', z.object({ id: z.uuid() }), (r) => {
    if (!r.success)
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await readableConversation(id, userId);
    return c.json({ conversationId: id, calls: await readRoomToolCalls(id, userId) });
  },
);
