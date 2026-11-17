/**
 * ISS-1268 — `POST /api/agent-sessions/:id/live`: what a running turn is producing right now,
 * posted by the device running it (`runner-agent/src/chat_live.rs`) and fanned out unstored as the
 * `agent-session.live` frame. Text and thinking stream here as they are generated; the turn's
 * stored transcript (`events-routes.ts`) keeps only the final message, which replaces them.
 *
 * Nothing is written, so nothing is refused for the session's status: the next prompt Claude Code
 * suggests arrives after the turn has closed. An item core cannot read is refused by name, the
 * batch with it.
 */

import { agentSessionLiveBatchSchema } from '@forge/contracts/agent-session-live';
import { CONVERSATION_AGENT_MARKER } from '@forge/contracts/agent-sessions';
import { Hono } from 'hono';
import type { AuthVars } from '../middleware/auth.js';
import { forbidden } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { broadcastLive } from './broadcast.js';
import { DEVICE_OWN } from './declarations.js';
import { assertDeviceOwnsSession, idParamSchema, loadSessionOr404 } from './session-access.js';

/** The room a session answers a turn of, or null for one that answers none. */
export function conversationOfSession(metadata: unknown): string | null {
  const marker = (metadata as Record<string, unknown> | null)?.[CONVERSATION_AGENT_MARKER];
  const id = (marker as { conversationId?: unknown } | null | undefined)?.conversationId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export const agentSessionLiveRoutes = new Hono<{ Variables: AuthVars }>();

agentSessionLiveRoutes.post(
  '/:id/live',
  zValidator('param', idParamSchema),
  DEVICE_OWN,
  zValidator(
    'json',
    agentSessionLiveBatchSchema,
    invalid(
      'invalid live batch: { items: [1..200] }, each item one of message, messageEnd, text, thinking, status, retry, compacted, rateLimit, context, ended, suggestion (@forge/contracts/agent-session-live)',
    ),
  ),
  async (c) => {
    const { id } = c.req.valid('param');
    const { items } = c.req.valid('json');
    if (!c.get('deviceId'))
      throw forbidden('only the device running this session may post what it produces');
    const session = await loadSessionOr404(id);
    assertDeviceOwnsSession(c, session);
    broadcastLive(session, conversationOfSession(session.metadata), items);
    return c.json({ shown: items.length }, 202);
  },
);
