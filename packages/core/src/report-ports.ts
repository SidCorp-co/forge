// The reports domain's ports, filled once at boot by the process entry: the query registry is a read
// model a domain may not import (ADR 0008), the room a block is posted into is the conversations
// context's, and a project's compute setting is its project document's, so each is handed in here
// from its owner's face. The executors are the sandboxes this deployment enabled: the chat
// provider's in-band one where its key is set (REQ-32 C2), else none, and every computation is then
// refused by name.

import { eq } from 'drizzle-orm';
import { chatDoorOfToken } from './agent-sessions/index.js';
import { postServiceAnswer } from './assistant/index.js';
import {
  agentTurnOfSession,
  derivedScope,
  readableConversation,
  stageAgentTurnBlock,
} from './conversations/index.js';
import { db } from './db/client.js';
import { conversationMessages } from './db/schema-conversations.js';
import { providerExecutors } from './integrations/llm/index.js';
import { readProjectDocument } from './project-config/index.js';
import { getReportQuery, listReportQueries, runReportQuery } from './report-queries/index.js';
import {
  provideExecutorPorts,
  provideExecutors,
  provideReportsPorts,
  type RestTurn,
} from './reports/index.js';

/** The room turn a REST caller's token answers, as `reports/rest-stage.ts` judges it. */
async function restTurnOf(tokenId: string | null): Promise<RestTurn> {
  const door = tokenId ? await chatDoorOfToken(tokenId) : null;
  if (!door) return { kind: 'none' };
  if (door.door === 'assistant-turn') return { kind: 'assistant-turn' };
  const read = await agentTurnOfSession(door.sessionId);
  if (!read.found) return { kind: 'session-gone', sessionId: door.sessionId };
  // a session on the Agents screen answers no room: it has no reply there for a block to wait on
  if (!read.turn) return { kind: 'none' };
  const sessionId = door.sessionId;
  return {
    kind: 'agent-turn',
    sessionId,
    conversationId: read.turn.conversationId,
    question: read.turn.question,
    settled: read.turn.settled,
    stage: (block) => stageAgentTurnBlock(sessionId, block),
  };
}

export function provideReportPorts(): void {
  provideReportsPorts({
    runQuery: runReportQuery,
    describeQuery: (queryId) => getReportQuery(queryId).descriptor,
    listQueries: () => listReportQueries().map((q) => q.descriptor),
    roomOf: async (conversationId, userId) => {
      const room = await readableConversation(conversationId, userId);
      return { adapter: room.adapter, projectIds: await derivedScope(conversationId) };
    },
    messageOf: async (messageId) => {
      const [row] = await db
        .select({
          conversationId: conversationMessages.conversationId,
          blocks: conversationMessages.blocks,
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, messageId))
        .limit(1);
      return row ?? null;
    },
    postAnswer: postServiceAnswer,
    restTurnOf,
  });
  provideExecutorPorts({
    computePolicyOf: async (projectId) => (await readProjectDocument(projectId))?.document.compute,
  });
  provideExecutors(providerExecutors());
}
