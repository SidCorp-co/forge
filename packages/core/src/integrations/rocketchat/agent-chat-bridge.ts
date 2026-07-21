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

import { scrubLogText } from '@forge/observability';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentSessions, type agentSessions as agentSessionsTable } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { AGENT_CHAT_FALLBACK_REPLY } from './agent-chat.js';
import { extractFinalAssistantText } from './escalation-bridge.js';
import { screenStakeholderReply } from './reply-screen.js';
import { postRoomMessage } from './rest-client.js';
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

const MAX_REPLY_CHARS = 4500;

function clip(text: string): string {
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}… [truncated]` : text;
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
    const verdict = await screenStakeholderReply(session.projectId, finalText, []);
    reply = verdict.ok ? finalText : AGENT_CHAT_FALLBACK_REPLY(meta.botName);
  }

  const safe = scrubLogText(clip(reply), [auth.authToken]);
  try {
    await postRoomMessage(auth, meta.rid, safe, meta.tmid ?? undefined);
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, rid: meta.rid },
      'rocketchat.agent-chat-bridge: chat.postMessage failed',
    );
  }
}
