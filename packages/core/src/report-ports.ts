// The reports domain's ports, filled once at boot by the process entry: the query registry is a read
// model a domain may not import (ADR 0008), and the room a block is posted into is the conversations
// context's, so both are handed in here from their owners' faces.

import { eq } from 'drizzle-orm';
import { publishToConversationReaders, WEB_CONVERSATION_EVENT } from './assistant/index.js';
import {
  appendMessages,
  derivedScope,
  handleForProject,
  readableConversation,
} from './conversations/index.js';
import { db } from './db/client.js';
import { conversationMessages } from './db/schema-conversations.js';
import { logger } from './lib/logger.js';
import { getReportQuery, listReportQueries, runReportQuery } from './report-queries/index.js';
import { provideReportsPorts } from './reports/index.js';

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
    postAnswer: async ({ conversationId, projectId, askerUserId, content, blocks }) => {
      const author = (await handleForProject(conversationId, projectId)) ?? askerUserId;
      const [message] = await appendMessages({
        conversationId,
        messages: [{ role: 'assistant', authorUserId: author, content, blocks }],
      });
      if (!message)
        throw new Error(`reports: the answer to conversation ${conversationId} was not stored`);
      await publishToConversationReaders(conversationId, {
        event: WEB_CONVERSATION_EVENT,
        data: { conversationId, messageId: message.id, role: 'assistant', content: '' },
      }).catch((err: unknown) => {
        logger.warn({ err, conversationId }, 'reports: the room was not told of the block');
      });
      return { messageId: message.id };
    },
  });
}
