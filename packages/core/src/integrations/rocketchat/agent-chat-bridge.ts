/**
 * ISS-727 — the `agent`-mode completion bridge. Unlike the escalation bridge
 * it runs NO synthesis turn: the session already produced the final
 * user-facing reply, so delivery screens it and posts it verbatim.
 */

import type { agentSessions as agentSessionsTable } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { problemsOf } from '../../messaging/contract.js';
import type { ProgressFacts } from '../../messaging/facts.js';
import { withRepairs } from '../../messaging/repairs.js';
import { screenReplyAtDoor } from '../../messaging/reply-screen.js';
import { resolveFailureCause } from '../../pipeline/failure-causes.js';
import { AGENT_CHAT_FALLBACK_REPLY, redispatchAgentChatSessionOnFailover } from './agent-chat.js';
import { FIXED_REPLY_CONSTANT, type ReplySendProof, sendFixedReply } from './outbound.js';
import {
  claimRoomReplyDelivery,
  extractFinalAssistantText,
  readRoomReplyMeta,
  resolveRoomPostAuth,
  roomStillBoundTo,
} from './room-delivery.js';

type SessionRow = typeof agentSessionsTable.$inferSelect;

function readProgressFacts(metadata: unknown): ProgressFacts | null | 'legacy-session' {
  const m = metadata as Record<string, unknown> | null;
  if (!m || !('progressFacts' in m)) return 'legacy-session';
  const pf = m.progressFacts;
  if (!pf || typeof pf !== 'object') return null;
  const p = pf as Record<string, unknown>;
  if (
    typeof p.shipped !== 'number' ||
    typeof p.closedUnshipped !== 'number' ||
    typeof p.inFlight !== 'number' ||
    typeof p.remaining !== 'number' ||
    typeof p.total !== 'number'
  ) {
    return null;
  }
  return {
    shipped: p.shipped,
    closedUnshipped: p.closedUnshipped,
    inFlight: p.inFlight,
    remaining: p.remaining,
    total: p.total,
  };
}

function extractToolCalls(messages: unknown): Array<{ name: string; arguments: string }> {
  if (!Array.isArray(messages)) return [];
  const calls: Array<{ name: string; arguments: string }> = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const toolCalls = (entry as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const t = tc as { name?: unknown; input?: unknown };
      if (typeof t.name !== 'string') continue;
      calls.push({ name: t.name, arguments: JSON.stringify(t.input ?? {}) });
    }
  }
  return calls;
}

export async function deliverAgentChatReplyOnce(session: SessionRow): Promise<void> {
  const meta = readRoomReplyMeta(session.metadata, 'agentChat');
  if (!meta) return;
  if (meta.deliveredAt) return;
  const bound = await roomStillBoundTo({
    connectionId: meta.connectionId,
    projectId: session.projectId,
    rid: meta.rid,
  });
  if (!bound) {
    await claimRoomReplyDelivery(session, 'agentChat');
    logger.error(
      { sessionId: session.id, rid: meta.rid, projectId: session.projectId },
      'rocketchat.agent-chat-bridge: the room is no longer bound to this project; the answer is not posted',
    );
    return;
  }
  if (!(await claimRoomReplyDelivery(session, 'agentChat'))) return;

  const failureCause = resolveFailureCause(session.failureReason);
  if (
    session.status !== 'completed' &&
    failureCause !== 'user_cancelled' &&
    failureCause !== 'skill_not_synced' &&
    failureCause !== 'ws_publish_failed'
  ) {
    const failover = await redispatchAgentChatSessionOnFailover(session);
    if (failover.ok) return;
  }

  const auth = await resolveRoomPostAuth(meta.connectionId, {
    sessionId: session.id,
    source: 'rocketchat.agent-chat-bridge',
  });
  if (!auth) return;

  const finalText =
    session.status === 'completed' ? extractFinalAssistantText(session.messages) : null;
  let reply: string;
  let proof: ReplySendProof = FIXED_REPLY_CONSTANT;
  if (!finalText) {
    reply = AGENT_CHAT_FALLBACK_REPLY(meta.botName);
  } else {
    const outcome = await withRepairs('agent-chat-completion', [finalText], {
      screen: () =>
        screenReplyAtDoor('agent-chat-completion', {
          projectId: session.projectId,
          segments: [finalText],
          toolCalls: extractToolCalls(session.messages),
          progress: readProgressFacts(session.metadata),
        }),
      rewrite: () => {
        throw new Error(
          'agent-chat-completion declares no repair; nothing can ask that session again',
        );
      },
    });
    if (outcome.kind === 'passed') {
      reply = finalText;
      proof = { ok: true, problems: [] };
    } else {
      logger.warn(
        { sessionId: session.id, rid: meta.rid, problems: problemsOf(outcome.verdict) },
        'rocketchat.agent-chat: the session reply failed the screen; honest fallback',
      );
      reply = AGENT_CHAT_FALLBACK_REPLY(meta.botName);
    }
  }

  if (
    !(await roomStillBoundTo({
      connectionId: meta.connectionId,
      projectId: session.projectId,
      rid: meta.rid,
    }))
  ) {
    logger.error(
      { sessionId: session.id, rid: meta.rid, projectId: session.projectId },
      'rocketchat.agent-chat-bridge: the room was rebound while this answer was prepared; the answer is not posted',
    );
    return;
  }

  try {
    await sendFixedReply(
      { kind: 'rest', auth, rid: meta.rid, tmid: meta.tmid ?? undefined },
      reply,
      proof,
    );
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, rid: meta.rid },
      'rocketchat.agent-chat-bridge: chat.postMessage failed',
    );
  }
}
