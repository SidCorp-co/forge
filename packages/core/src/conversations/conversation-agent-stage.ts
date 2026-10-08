// Where a block an Agent-mode turn posts over REST waits: on the session answering the room, under
// its conversation marker, until the bridge judges the session's reply
// (`conversation-agent-bridge.ts`). Nothing here writes into the room, so no reader of it sees a
// block before the reply it belongs to passes.

import type { SessionAsker } from '@forge/contracts/agent-sessions';
import { eq, sql } from 'drizzle-orm';
import { appendUnclaimedMarkerItem } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions, pipelineRuns } from '../db/schema.js';
import type { StagedBlock } from '../lib/staged-block.js';
import {
  CONVERSATION_AGENT_MARKER,
  CONVERSATION_AGENT_RUN_SOURCE,
  readConversationAgentMeta,
} from './conversation-agent-meta.js';

/**
 * The room turn a session answers, read now. `answersRoom` is read from where the session was
 * started — the run core opened it under, which no session can write — never from its own metadata:
 * a session started from the Agents screen or a Rocket.Chat escalation answers no room whatever its
 * metadata says, and one started for a room turn answers that room even where its marker cannot be
 * read, so a reader that must know which room can refuse rather than take it for one answering none.
 */
export type AgentTurnOfSession =
  | { found: false }
  | { found: true; answersRoom: false; turn: null }
  | {
      found: true;
      answersRoom: true;
      /** Null where the marker the room turn is read from is gone or unreadable. */
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
      } | null;
    };

export async function agentTurnOfSession(sessionId: string): Promise<AgentTurnOfSession> {
  const [row] = await db
    .select({
      metadata: agentSessions.metadata,
      createdAt: agentSessions.createdAt,
      runSource: sql<unknown>`${pipelineRuns.metadata} ->> 'source'`,
    })
    .from(agentSessions)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, agentSessions.pipelineRunId))
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row) return { found: false };
  if (row.runSource !== CONVERSATION_AGENT_RUN_SOURCE) {
    return { found: true, answersRoom: false, turn: null };
  }
  const meta = readConversationAgentMeta(row.metadata);
  if (!meta) return { found: true, answersRoom: true, turn: null };
  return {
    found: true,
    answersRoom: true,
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
