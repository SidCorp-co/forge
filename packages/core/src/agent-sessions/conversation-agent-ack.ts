/**
 * The "still working" sentence a slow runner-hosted turn posts, and nothing else.
 *
 * Split out of `conversation-agent.ts` for the size budget (ISS-1039). It is its
 * own file rather than an inline helper because BOTH the first dispatch and the
 * failover schedule one, and a second copy for the retry is how one of the two
 * windows goes silent.
 */

import { eq } from 'drizzle-orm';
import { codeAuthored, conversationTransport } from '../conversations/ports.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../logger.js';
import { type ConversationAgentMeta, readConversationAgentMeta } from './conversation-agent.js';

/**
 * Post an interim ack, but only if the turn is genuinely slow.
 */
// cm:guard best-effort by design: the timer is `unref`-ed and a core restart inside the window simply drops the ack, because the answer still arrives via the bridge and a hung session is still reaped by the loop monitor — an undelivered ack must never surface as a failure.
// cm:guard it is NOT recorded in the transcript: it is this handle saying it is working, not the answer, and a room's log holding it would make the eventual reply read as a second message about the same question.
// cm:guard a venue whose reader already sees the turn's state needs no ack at all, which is what a null `replies.ack` says: the Forge UI prints `dispatched` and `running` on the thread, so a sentence promising an answer would be the same fact twice (ISS-1039).
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
