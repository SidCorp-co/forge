// Where a block an Agent-mode turn posts over REST waits: on the session answering the room, under
// its conversation marker, until the bridge judges the session's reply
// (`conversation-agent-bridge.ts`). Nothing here writes into the room, so no reader of it sees a
// block before the reply it belongs to passes.

import type { SessionAsker } from '@forge/contracts/agent-sessions';
import { eq } from 'drizzle-orm';
import { appendUnclaimedMarkerItem } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import type { StagedBlock } from '../lib/staged-block.js';
import { CONVERSATION_AGENT_MARKER, readConversationAgentMeta } from './conversation-agent-meta.js';

/**
 * The room turn a session answers, read now: null where the session answers no room. `marked` says
 * the session carries the room marker all the same, unreadable, so a reader that must know which
 * room it answers can refuse rather than take it for a session that answers none.
 */
export type AgentTurnOfSession =
  | { found: false }
  | { found: true; turn: null; marked: boolean }
  | {
      found: true;
      turn: {
        conversationId: string;
        question: string;
        /** The bridge already took the reply for delivery: nothing may join it now. */
        settled: boolean;
        staged: StagedBlock[];
        /** The person the turn answers, and the project its room asked about. */
        asker: SessionAsker | null;
        projectId: string;
        /** When the session started: what it was shown was proposed before this. */
        startedAt: Date;
      };
    };

export async function agentTurnOfSession(sessionId: string): Promise<AgentTurnOfSession> {
  const [row] = await db
    .select({ metadata: agentSessions.metadata, createdAt: agentSessions.createdAt })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row) return { found: false };
  const meta = readConversationAgentMeta(row.metadata);
  if (!meta) {
    const marked = (row.metadata as Record<string, unknown> | null)?.[CONVERSATION_AGENT_MARKER];
    return { found: true, turn: null, marked: marked !== undefined && marked !== null };
  }
  return {
    found: true,
    turn: {
      conversationId: meta.conversationId,
      question: meta.question,
      settled: meta.claimedAt !== null || meta.deliveredAt !== null,
      staged: meta.staged,
      asker: meta.asker,
      projectId: meta.venue.projectId,
      startedAt: row.createdAt,
    },
  };
}

/**
 * Hold one block on the session's turn until its reply is judged; false where the bridge already
 * took that reply for delivery, so the block would have no reply to go out with.
 */
export function stageAgentTurnBlock(sessionId: string, block: StagedBlock): Promise<boolean> {
  return appendUnclaimedMarkerItem(sessionId, CONVERSATION_AGENT_MARKER, 'staged', block);
}
