import { and, desc, eq, gte, lte } from 'drizzle-orm';
import {
  CONVERSATION_AGENT_MARKER,
  readConversationAgentMeta,
} from '../agent-sessions/conversation-agent.js';
import { agentSessions } from '../db/schema.js';
import { conversationMessages, conversationWindows } from '../db/schema-conversations.js';
import type { QuestionOrigin } from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/dependency-executor.js';

/** The pool, or a caller's open transaction — a park resolves its origin inside the transition's. */
type QuestionExecutor = IssueDependencyExecutor;

/**
 * The origin of an ask, or null where this question belongs to no conversation.
 */
export async function resolveAskOrigin(
  executor: QuestionExecutor,
  agentSessionId: string | undefined,
): Promise<QuestionOrigin | null> {
  if (!agentSessionId) return null;

  const [session] = await executor
    .select({ metadata: agentSessions.metadata })
    .from(agentSessions)
    .where(eq(agentSessions.id, agentSessionId))
    .limit(1);
  if (!session) return null;

  const raw = (session.metadata as Record<string, unknown> | null)?.[CONVERSATION_AGENT_MARKER];
  if (raw === undefined || raw === null) return null;

  const meta = readConversationAgentMeta(session.metadata);
  if (!meta) {
    return {
      kind: 'unresolved',
      reason:
        'the asking session names a conversation turn whose venue, conversation or window could not be read from its own record',
    };
  }

  const [window] = await executor
    .select({ firstSeq: conversationWindows.firstSeq, lastSeq: conversationWindows.lastSeq })
    .from(conversationWindows)
    .where(eq(conversationWindows.id, meta.windowId))
    .limit(1);
  if (!window) {
    return {
      kind: 'unresolved',
      reason: `the asking session names conversation window ${meta.windowId}, and no such window is on the record`,
    };
  }

  const [message] = await executor
    .select({
      externalId: conversationMessages.externalId,
      authorUserId: conversationMessages.authorUserId,
      authorLabel: conversationMessages.authorLabel,
      authorKey: conversationMessages.authorKey,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, meta.conversationId),
        eq(conversationMessages.role, 'user'),
        gte(conversationMessages.seq, window.firstSeq),
        lte(conversationMessages.seq, window.lastSeq),
      ),
    )
    .orderBy(desc(conversationMessages.seq))
    .limit(1);
  if (!message) {
    return {
      kind: 'unresolved',
      reason: `conversation window ${meta.windowId} holds no inbound message, so this question has nothing to be anchored on and nobody to be addressed to`,
    };
  }

  return {
    kind: 'conversation',
    adapter: meta.venue.adapter,
    venueId: meta.venue.externalId,
    conversationId: meta.conversationId,
    windowId: meta.windowId,
    anchorId: message.externalId,
    askedByUserId: message.authorUserId,
    askedByLabel: message.authorLabel ?? meta.askedByLabel,
    askedByKey: message.authorKey,
  };
}
