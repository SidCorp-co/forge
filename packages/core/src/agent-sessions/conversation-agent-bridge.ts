/**
 * The completion bridge for a conversation turn a runner answered.
 *
 * ISS-727's bridge posted through Rocket.Chat's own REST client, re-read
 * Rocket.Chat's own bindings and spoke Rocket.Chat's own fallbacks. This one
 * holds a venue and asks that venue's transport, so the browser's socket and a
 * Rocket.Chat room are the same call. It runs NO synthesis turn: the session
 * already produced the final user-facing reply, so delivery screens it and
 * delivers it verbatim.
 */

import { and, eq, sql } from 'drizzle-orm';
import { codeAuthored, conversationTransport, screened } from '../conversations/ports.js';
import { recordDeliveredReply } from '../conversations/transcript.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../logger.js';
import { type MessageVerdict, problemsOf } from '../messaging/contract.js';
import type { ProgressFacts } from '../messaging/facts.js';
import { withRepairs } from '../messaging/repairs.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import { resolveFailureCause } from '../pipeline/failure-causes.js';
import {
  CONVERSATION_AGENT_MARKER,
  type ConversationAgentMeta,
  readConversationAgentMeta,
} from './conversation-agent.js';
import { redispatchConversationAgentTurn } from './conversation-agent-failover.js';
import { messageRoleToTurnRole } from './turns-helpers.js';

type SessionRow = typeof agentSessions.$inferSelect;

/**
 * What the venue is told, and what the screen recorded about it.
 */
type Outcome = {
  text: string;
  problems: readonly string[];
  failure: string | null;
  passed: MessageVerdict | null;
};

function readProgressFacts(metadata: unknown): ProgressFacts | null | 'legacy-session' {
  const m = metadata as Record<string, unknown> | null;
  if (!m || !('progressFacts' in m)) return 'legacy-session';
  const pf = m.progressFacts;
  if (!pf || typeof pf !== 'object') return null;
  const p = pf as Record<string, unknown>;
  const keys = ['shipped', 'closedUnshipped', 'inFlight', 'remaining', 'total'] as const;
  if (keys.some((k) => typeof p[k] !== 'number')) return null;
  return {
    shipped: p.shipped as number,
    closedUnshipped: p.closedUnshipped as number,
    inFlight: p.inFlight as number,
    remaining: p.remaining as number,
    total: p.total as number,
  };
}

function extractToolCalls(messages: unknown): Array<{ name: string; arguments: string }> {
  if (!Array.isArray(messages)) return [];
  const calls: Array<{ name: string; arguments: string }> = [];
  for (const entry of messages) {
    const toolCalls = (entry as { toolCalls?: unknown } | null)?.toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const t = tc as { name?: unknown; input?: unknown } | null;
      if (!t || typeof t.name !== 'string') continue;
      calls.push({ name: t.name, arguments: JSON.stringify(t.input ?? {}) });
    }
  }
  return calls;
}

function finalAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messageRoleToTurnRole(messages[i]) !== 'assistant') continue;
    const content = (messages[i] as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim().length > 0) return content.trim();
  }
  return null;
}

/**
 * Stamp this session as the one that delivers, at most once.
 */
async function claimDelivery(session: SessionRow, failure: string | null): Promise<boolean> {
  const prev = (session.metadata as Record<string, unknown>) ?? {};
  const prevMarker = (prev[CONVERSATION_AGENT_MARKER] as Record<string, unknown>) ?? {};
  const claimed = await db
    .update(agentSessions)
    .set({
      metadata: {
        ...prev,
        [CONVERSATION_AGENT_MARKER]: {
          ...prevMarker,
          claimedAt: new Date().toISOString(),
          ...(failure ? { deliveredAt: new Date().toISOString(), failure } : { failure: null }),
        },
      } as never,
    })
    .where(
      and(
        eq(agentSessions.id, session.id),
        sql`(${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'claimedAt') IS NULL AND (${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'deliveredAt') IS NULL`,
      ),
    )
    .returning({ id: agentSessions.id });
  return claimed.length > 0;
}

/** The answer is in the transcript: stamp the fact, which is what the screen reads. */
async function stampDelivered(sessionId: string): Promise<void> {
  const [row] = await db
    .select({ metadata: agentSessions.metadata })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  const prev = (row?.metadata as Record<string, unknown>) ?? {};
  const marker = (prev[CONVERSATION_AGENT_MARKER] as Record<string, unknown>) ?? {};
  await db
    .update(agentSessions)
    .set({
      metadata: {
        ...prev,
        [CONVERSATION_AGENT_MARKER]: { ...marker, deliveredAt: new Date().toISOString() },
      } as never,
    })
    .where(eq(agentSessions.id, sessionId));
}

/** Re-stamp which failure the venue was shown, once the delivery is already claimed. */
async function stampFailure(sessionId: string, failure: string): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      metadata: sql`jsonb_set(${agentSessions.metadata}, ${sql.raw(`'{${CONVERSATION_AGENT_MARKER},failure}'`)}, ${JSON.stringify(failure)}::jsonb, true)`,
    })
    .where(eq(agentSessions.id, sessionId));
}

async function composeOutcome(session: SessionRow, meta: ConversationAgentMeta): Promise<Outcome> {
  const text = session.status === 'completed' ? finalAssistantText(session.messages) : null;
  if (!text) {
    return {
      text: meta.replies.failed,
      problems: [],
      passed: null,
      failure:
        session.status === 'completed'
          ? 'the session finished without writing a reply'
          : `the session ended ${session.status}`,
    };
  }
  const verdict = await withRepairs(meta.door, [text], {
    screen: () =>
      screenReplyAtDoor(meta.door, {
        projectId: session.projectId,
        segments: [text],
        toolCalls: extractToolCalls(session.messages),
        progress: readProgressFacts(session.metadata),
      }),
    rewrite: () => {
      throw new Error(`${meta.door} declares no repair; nothing can ask that session again`);
    },
  });
  if (verdict.kind === 'passed')
    return { text, problems: [], failure: null, passed: verdict.verdict };
  logger.warn(
    {
      sessionId: session.id,
      conversationId: meta.conversationId,
      problems: problemsOf(verdict.verdict),
    },
    'conversation-agent-bridge: the session reply failed the screen; honest fallback',
  );
  return {
    text: meta.replies.failed,
    problems: [],
    passed: null,
    failure: 'the reply this session wrote could not be shown here',
  };
}

/**
 * Deliver one runner-hosted conversation reply, at most once.
 */
export async function deliverConversationAgentReplyOnce(session: SessionRow): Promise<void> {
  const meta = readConversationAgentMeta(session.metadata);
  if (!meta) return;
  if (meta.deliveredAt) return;

  const transport = conversationTransport(meta.venue.adapter);
  if (!transport) {
    logger.error(
      { sessionId: session.id, adapter: meta.venue.adapter },
      'conversation-agent-bridge: no transport is registered for this venue; the answer is not delivered',
    );
    return;
  }

  if (transport.canDeliver && !(await transport.canDeliver(meta.venue))) {
    await claimDelivery(session, 'the room this was asked in is no longer reachable');
    logger.error(
      { sessionId: session.id, conversationId: meta.conversationId, adapter: meta.venue.adapter },
      'conversation-agent-bridge: the venue is no longer reachable; the answer is not posted',
    );
    return;
  }

  if (!(await claimDelivery(session, null))) return;

  const cause = resolveFailureCause(session.failureReason);
  if (
    session.status !== 'completed' &&
    cause !== 'user_cancelled' &&
    cause !== 'skill_not_synced' &&
    cause !== 'ws_publish_failed'
  ) {
    const failover = await redispatchConversationAgentTurn(session);
    if (failover.ok) {
      await stampDelivered(session.id);
      return;
    }
  }

  const outcome = await composeOutcome(session, meta);
  const message =
    outcome.failure || !outcome.passed
      ? codeAuthored(outcome.text)
      : (screened(outcome.text, meta.door, outcome.passed) ?? codeAuthored(meta.replies.failed));

  try {
    const receipt = await transport.deliver(meta.venue, message);
    await recordDeliveredReply({
      conversationId: meta.conversationId,
      projectId: meta.venue.projectId,
      text: message.text,
      receipt,
      deliveryKey: meta.deliveryKey,
      decision: 'handed-off',
    });
    await stampDelivered(session.id);
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, conversationId: meta.conversationId },
      'conversation-agent-bridge: the reply could not be delivered; nothing was recorded',
    );
    await stampFailure(session.id, 'the reply could not be delivered to this room');
    return;
  }

  if (outcome.failure) await stampFailure(session.id, outcome.failure);

  await transport
    .notifySettled?.(meta.venue)
    .catch((err: unknown) =>
      logger.warn(
        { err, sessionId: session.id, conversationId: meta.conversationId },
        'conversation-agent-bridge: delivered, but the settled event was not published',
      ),
    );
}
