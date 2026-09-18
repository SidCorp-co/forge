/**
 * The completion bridge for Rocket.Chat `agent`-mode sessions dispatched under
 * ISS-727's metadata shape — a connection id, a room id, a thread id and a bot
 * name, and no venue.
 *
 * ISS-1039 moved that lane onto `agent-sessions/conversation-agent-bridge.ts`,
 * which reads a venue and delivers through that venue's own transport. Nothing
 * writes `metadata.agentChat` any more. This exists for the sessions that were
 * already running when that landed and go terminal afterwards: their rows name
 * a room the neutral bridge cannot read, so without this the room they were
 * asked in is simply never answered.
 */
// cm:hack ISS-1039 until: no `agent_sessions` row with a non-terminal status carries a `metadata.agentChat` key. What it costs: one extra reader on every terminal session write, and the failover this lane used to have — an in-flight legacy session whose runner dies on infrastructure now gets the honest fallback sentence rather than another box, because the redispatch it called was rebuilt around the venue shape these rows do not have. That is the price of not carrying a second copy of the dispatcher for rows nobody will create again.
// cm:guard NOT a compatibility branch inside the neutral bridge, deliberately: a row this shape is a different contract, not a variant of the new one, and reading both from one function is how the old shape survives the condition above. It is a separate file so deleting it is one `rm` and one line off the bridge list.

import type { agentSessions as agentSessionsTable } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { problemsOf } from '../../messaging/contract.js';
import type { ProgressFacts } from '../../messaging/facts.js';
import { proven, wholeAgentText } from '../../messaging/proven.js';
import { withRepairs } from '../../messaging/repairs.js';
import { screenReplyAtDoor } from '../../messaging/reply-screen.js';
import { AGENT_CHAT_FALLBACK_REPLY } from './agent-chat.js';
import { FIXED_REPLY_CONSTANT, type ReplySendProof, sendFixedReply } from './outbound.js';
import {
  claimRoomReplyDelivery,
  extractFinalAssistantText,
  readRoomReplyMeta,
  resolveRoomPostAuth,
  roomStillBoundTo,
} from './room-delivery.js';

type SessionRow = typeof agentSessionsTable.$inferSelect;

// cm:guard three distinct meanings, do not collapse them: a snapshot screens against itself; `null` means the key IS present but its computation failed, which fails CLOSED; `'legacy-session'` (key absent entirely, pre-ISS-818 row) is the only case that self-computes, and is named rather than `undefined` so a caller who merely forgot the argument cannot reach it
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

// cm:why one-shot dispatch means the whole transcript IS the turn the claimed-creation check judges, so there is no "final turn" to isolate — unlike the escalation bridge, whose reply comes from a separate Bao turn and passes []
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

export async function deliverLegacyAgentChatReplyOnce(session: SessionRow): Promise<void> {
  const meta = readRoomReplyMeta(session.metadata, 'agentChat');
  if (!meta) return;
  if (meta.deliveredAt) return;
  // cm:guard the room is checked against THIS session's project BEFORE the claim: an agent session runs long, a room rebound while it ran is not this project's to answer into, and a throw from this lookup after the claim would spend the one stamp this delivery has (ISS-1001).
  // cm:guard FIRST of a pair — the second read sits immediately before `sendFixedReply` below and BOTH are load-bearing: drop this one and a rebound room still costs a failover redispatch and a screening turn, drop that one and the answer they produce is posted into a room that moved (ISS-1001).
  const bound = await roomStillBoundTo({
    connectionId: meta.connectionId,
    projectId: session.projectId,
    rid: meta.rid,
  });
  if (!bound) {
    await claimRoomReplyDelivery(session, 'agentChat');
    logger.error(
      { sessionId: session.id, rid: meta.rid, projectId: session.projectId },
      'rocketchat.legacy-agent-chat-bridge: the room is no longer bound to this project; the answer is not posted',
    );
    return;
  }
  if (!(await claimRoomReplyDelivery(session, 'agentChat'))) return;

  // cm:why the CAS claim above already stamped THIS session's deliveredAt, so retrying here can never double-post — its "delivery" is really a hand-off to the retry; a content-side outcome (completed, no usable/screened text) is never retried, since retrying would just reproduce the same content decision; deterministic non-infra failures (skill_not_synced, ws_publish_failed) are excluded because retrying them on every runner produces the same outcome
  // cm:guard compare the RESOLVED cause, never the raw column — rows written before ISS-877 carry `ws-publish-failed` with a hyphen, and a literal comparison silently starts failing over the one class this list exists to exclude
  const auth = await resolveRoomPostAuth(meta.connectionId, {
    sessionId: session.id,
    source: 'rocketchat.legacy-agent-chat-bridge',
  });
  if (!auth) return;

  const finalText =
    session.status === 'completed' ? extractFinalAssistantText(session.messages) : null;
  let reply: string;
  let proof: ReplySendProof = FIXED_REPLY_CONSTANT;
  if (!finalText) {
    reply = AGENT_CHAT_FALLBACK_REPLY(meta.botName);
  } else {
    // cm:guard this door declares ZERO repairs and that is not an oversight: `finalText` is the last message of a runner session that has already ended, so there is no turn to ask again and a budget here would be one this door could never spend. It still goes through `withRepairs` so the count lives in the door table beside its reason rather than as an absent loop nobody can see (ISS-997).
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
    const admitted =
      outcome.kind === 'passed'
        ? // cm:guard minted from the verdict that passed, over the exact string being posted. The
          // hand-built `{ ok: true, problems: [] }` this replaces claimed a screen had run and named
          // nothing it had run over — ISS-978 F5.
          proven('agent-chat-completion', wholeAgentText(finalText), outcome.verdict)
        : null;
    if (admitted) {
      reply = admitted.text;
      proof = admitted;
    } else {
      logger.warn(
        { sessionId: session.id, rid: meta.rid, problems: problemsOf(outcome.verdict) },
        'rocketchat.legacy-agent-chat: the session reply failed the screen; honest fallback',
      );
      reply = AGENT_CHAT_FALLBACK_REPLY(meta.botName);
    }
  }

  // cm:guard the binding is read a SECOND time, here, because everything since the first read takes time a rebind fits inside — a failover redispatch and a screening turn, either of them minutes — and the first read cannot know what happened during them (ISS-1001).
  // cm:why no claim is touched here: the claim above is already spent and that is right, since a rebound room is terminal for THIS delivery; the answer is not re-queued, because the project that would retry it is no longer the room's.
  if (
    !(await roomStillBoundTo({
      connectionId: meta.connectionId,
      projectId: session.projectId,
      rid: meta.rid,
    }))
  ) {
    logger.error(
      { sessionId: session.id, rid: meta.rid, projectId: session.projectId },
      'rocketchat.legacy-agent-chat-bridge: the room was rebound while this answer was prepared; the answer is not posted',
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
      'rocketchat.legacy-agent-chat-bridge: chat.postMessage failed',
    );
  }
}
