// Where a question was asked, read at the moment it is asked.
//
// A question raised by a session that is answering a conversation window
// belongs to that window's room and to the person whose message raised it, and
// nothing later can re-derive either: a room is rebound, a session's metadata is
// rewritten, and a destination worked out at delivery time answers to the
// project rather than to whoever asked (ISS-1091).
//
// The asking session carries its window in `metadata.conversationAgent`. What
// that marker does NOT carry is the inbound message's own id or a stable
// identity for the speaker, so both are read from `conversation_messages` for
// the marker's window.

import { and, desc, eq, gte, lte } from 'drizzle-orm';
import {
  CONVERSATION_AGENT_MARKER,
  readConversationAgentMeta,
} from '../agent-sessions/conversation-agent.js';
import { conversationMessages, conversationWindows } from '../db/schema-conversations.js';
import type { QuestionOrigin } from '../db/schema-questions.js';
import { agentSessions } from '../db/schema.js';
import type { IssueDependencyExecutor } from '../issues/dependency-executor.js';

/** The pool, or a caller's open transaction — a park resolves its origin inside the transition's. */
type QuestionExecutor = IssueDependencyExecutor;

/**
 * The origin of an ask, or null where this question belongs to no conversation.
 */
// cm:guard THREE answers and not two. `null` is "no conversation asked this" and is the ONLY value
// that reaches `roomForProject`; a marker that is present and unreadable answers `unresolved` with
// its reason instead, because `readConversationAgentMeta` returns null for an absent marker and for
// a malformed one alike, and collapsing the two posts a conversation's question into a room nobody
// in that conversation is in — the exact failure this module exists to end (ISS-1091 criteria 10, 11).
// cm:guard the LAST inbound message of the window wins where several people spoke in it: that is the
// message the asking turn was answering when it had to stop and ask, so it is the one the round is
// anchored on and the person it names. Taking the first would thread the question under somebody who
// had already been answered.
// cm:guard read through the CALLER's executor, so a park that mints its question inside the
// transition's transaction resolves the origin in that same transaction: an origin written by a
// second connection is one a rollback of the park leaves behind, pointing at a window whose question
// does not exist.
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
