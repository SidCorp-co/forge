/**
 * ISS-727 — the `agent`-mode completion bridge: fires when an agent-chat
 * session (`metadata.agentChat` set by `agent-chat.ts`) reaches a terminal
 * status, from EITHER of the two writers that can flip a session terminal —
 * `agent-sessions/routes.ts` PATCH `/:id` (the runner happy-path) and
 * `lifecycle/transition.ts`'s `applyKernelTransition` (every other terminal
 * writer: sweeper timeout, cascade, cancel, dispatch-failure). Mirrors the
 * escalation bridge's wiring exactly — see `escalation-bridge.ts`'s header
 * for why both sites are required.
 *
 * Unlike the escalation bridge, this one does NOT run a synthesis turn: the
 * agent-chat session already produced the FINAL user-facing reply (see
 * `buildAgentChatPrompt`), so delivery only needs to extract it, run it
 * through the same kernel output-guard (`screenStakeholderReply`), and post
 * it — verbatim on success, an honest fallback otherwise.
 *
 * `deliverAgentChatReplyOnce` is idempotent via a CAS stamp
 * (`metadata.agentChat.deliveredAt`), so it is safe to call from both sites
 * (or the same site twice) without a double post.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentSessions, type agentSessions as agentSessionsTable } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { AGENT_CHAT_FALLBACK_REPLY, redispatchAgentChatSessionOnFailover } from './agent-chat.js';
import { extractFinalAssistantText } from './escalation-bridge.js';
import { sendFixedReply } from './outbound.js';
import type { ProgressFacts } from './reply-guard.js';
import { screenStakeholderReply } from './reply-screen.js';
import { resolveRoomPostAuth } from './room-delivery.js';

type SessionRow = typeof agentSessionsTable.$inferSelect;

interface AgentChatMeta {
  connectionId: string;
  rid: string;
  tmid: string | null;
  botName: string;
  askedByUsername: string;
  question: string;
  deliveredAt: string | null;
}

function readAgentChatMeta(metadata: unknown): AgentChatMeta | null {
  const ac = (metadata as { agentChat?: unknown } | null)?.agentChat;
  if (!ac || typeof ac !== 'object') return null;
  const a = ac as Record<string, unknown>;
  if (
    typeof a.connectionId !== 'string' ||
    typeof a.rid !== 'string' ||
    typeof a.botName !== 'string'
  ) {
    return null;
  }
  return {
    connectionId: a.connectionId,
    rid: a.rid,
    tmid: typeof a.tmid === 'string' ? a.tmid : null,
    botName: a.botName,
    askedByUsername: typeof a.askedByUsername === 'string' ? a.askedByUsername : '',
    question: typeof a.question === 'string' ? a.question : '',
    deliveredAt: typeof a.deliveredAt === 'string' ? a.deliveredAt : null,
  };
}

/** `metadata.progressFacts` as stored by `startAgentChat`/the failover retry
 *  — the snapshot the session's prompt was actually built with (ISS-671).
 *  Returns `undefined` (not `null`) when the key is entirely absent — an
 *  in-flight session created before this field existed — so the caller's
 *  `screenStakeholderReply(..., readProgressFacts(...))` self-computes
 *  instead of failing closed on a session that was simply never given a
 *  snapshot to check against. `null` means the key IS present but the
 *  snapshot computation failed when the session was created — that DOES
 *  fail closed, same as any other guard failure. */
function readProgressFacts(metadata: unknown): ProgressFacts | null | undefined {
  const m = metadata as Record<string, unknown> | null;
  if (!m || !('progressFacts' in m)) return undefined;
  const pf = m.progressFacts;
  if (!pf || typeof pf !== 'object') return null;
  const p = pf as Record<string, unknown>;
  if (
    typeof p.done !== 'number' ||
    typeof p.inFlight !== 'number' ||
    typeof p.remaining !== 'number' ||
    typeof p.total !== 'number'
  ) {
    return null;
  }
  return { done: p.done, inFlight: p.inFlight, remaining: p.remaining, total: p.total };
}

/**
 * Tool calls the runner actually made, flattened across every assistant
 * message in the transcript (`agent-stream-parser.ts`'s `ToolCall` shape:
 * `{id, name, input}`). One-shot dispatch (ISS-727) means the whole
 * transcript IS the one turn `screenStakeholderReply`'s claimed-creation
 * check is judging, so there is no "final turn" to isolate — unlike the
 * escalation bridge, which passes `[]` because its synthesis reply comes
 * from a separate Bao turn with no tool calls of its own.
 */
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

/**
 * Deliver an agent-chat session's final answer to its originating
 * RocketChat room/thread — exactly once. No-op when `session` is not an
 * agent-chat session, or the CAS stamp shows it was already delivered.
 */
export async function deliverAgentChatReplyOnce(session: SessionRow): Promise<void> {
  const meta = readAgentChatMeta(session.metadata);
  if (!meta) return;
  if (meta.deliveredAt) return;

  const prevMetadata = (session.metadata as Record<string, unknown>) ?? {};
  const prevAgentChat = (prevMetadata.agentChat as Record<string, unknown>) ?? {};
  const now = new Date().toISOString();
  const nextMetadata = {
    ...prevMetadata,
    agentChat: { ...prevAgentChat, deliveredAt: now },
  };

  // CAS: exactly one caller wins even if the PATCH /:id happy-path and the
  // applyKernelTransition sweeper/failure hook race on the same session.
  const claimed = await db
    .update(agentSessions)
    .set({ metadata: nextMetadata as never })
    .where(
      and(
        eq(agentSessions.id, session.id),
        sql`(${agentSessions.metadata} -> 'agentChat' ->> 'deliveredAt') IS NULL`,
      ),
    )
    .returning({ id: agentSessions.id });
  if (claimed.length === 0) return;

  // cm:why the CAS claim above already stamped THIS session's deliveredAt, so retrying here can never double-post — its "delivery" is really a hand-off to the retry; a content-side outcome (completed, no usable/screened text) is never retried, since retrying would just reproduce the same content decision; deterministic non-infra failures (skill_not_synced, ws-publish-failed) are excluded because retrying them on every runner produces the same outcome
  if (
    session.status !== 'completed' &&
    session.failureReason !== 'user_cancelled' &&
    session.failureReason !== 'skill_not_synced' &&
    session.failureReason !== 'ws-publish-failed'
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
  if (!finalText) {
    reply = AGENT_CHAT_FALLBACK_REPLY(meta.botName);
  } else {
    const verdict = await screenStakeholderReply(
      session.projectId,
      finalText,
      extractToolCalls(session.messages),
      readProgressFacts(session.metadata),
    );
    reply = verdict.ok ? finalText : AGENT_CHAT_FALLBACK_REPLY(meta.botName);
  }

  try {
    await sendFixedReply(
      { kind: 'rest', auth, rid: meta.rid, tmid: meta.tmid ?? undefined },
      reply,
    );
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, rid: meta.rid },
      'rocketchat.agent-chat-bridge: chat.postMessage failed',
    );
  }
}
