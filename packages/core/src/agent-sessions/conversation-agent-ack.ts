import { eq } from 'drizzle-orm';
import { codeAuthored, conversationTransport } from '../conversations/ports.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../logger.js';
import { type ConversationAgentMeta, readConversationAgentMeta } from './conversation-agent.js';

/**
 * Post an interim ack, but only if the turn is genuinely slow.
 */
export function scheduleAck(sessionId: string, marker: ConversationAgentMeta): void {
  if (!marker.replies.ack || marker.ackAfterMs === null) return;
  const timer = setTimeout(() => {
    void postAck(sessionId, marker);
  }, marker.ackAfterMs);
  timer.unref?.();
}

async function postAck(sessionId: string, marker: ConversationAgentMeta): Promise<void> {
  try {
    const [row] = await db
      .select({ status: agentSessions.status, metadata: agentSessions.metadata })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    if (row?.status !== 'running') return;
    if (readConversationAgentMeta(row.metadata)?.deliveredAt) return;
    const transport = conversationTransport(marker.venue.adapter);
    if (!transport || !marker.replies.ack) return;
    await transport.deliver(marker.venue, codeAuthored(marker.replies.ack));
  } catch (err) {
    logger.error({ err, sessionId }, 'conversation-agent: the interim ack could not be posted');
  }
}
