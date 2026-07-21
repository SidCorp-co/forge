/**
 * ISS-727 — `agent`-mode dispatcher. When a project's RC answer-mode
 * (`answer-mode.ts`) is `agent`, EVERY real turn (not just an escalated one)
 * routes here instead of the fast provider-chat path: dedup against any
 * in-flight agent-chat turn for the same room, resolve a runner device, and
 * dispatch a runner-hosted `system` agent-session (product lens, ISS-674)
 * with the user's message. The session's reply is delivered later by the
 * completion bridge (`agent-chat-bridge.ts`), wired at every session-terminal
 * writer — this module never posts to the room itself.
 *
 * Mirrors `escalation.ts`'s dispatch machinery exactly (same
 * `resolveChatDevice` / `createChatSessionRow` / `dispatchChatTurn` reuse,
 * same "mark failed on dispatch throw" safety net). It differs only in
 * prompt shape — this asks for the FINAL user-facing reply directly and
 * verbatim, since there is no Bao synthesis turn on this path — and dedup
 * marker (`metadata.agentChat` vs `metadata.escalation`).
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchChatTurn,
  resolveChatDevice,
} from '../../agent-sessions/chat-turn.js';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { applyKernelTransition } from '../../lifecycle/transition.js';
import { logger } from '../../logger.js';
import { postRoomMessage } from './rest-client.js';
import { resolveRoomPostAuth } from './room-delivery.js';

const AGENT_CHAT_TITLE_MAX = 80;

/**
 * How long a runner-hosted turn may run before Babo posts an interim
 * "still working" ack to the room. Under this, the runner's real answer
 * (delivered by `agent-chat-bridge.ts` the moment the session goes terminal)
 * arrives on its own with NO ack in front of it — the common fast case.
 * Only a genuinely slow turn ever shows the ack.
 */
export const AGENT_CHAT_ACK_DELAY_MS = 2 * 60 * 1000;

export const AGENT_CHAT_ACK = (botName: string): string =>
  `${botName} đang xử lý câu hỏi này qua trợ lý đầy đủ, lát nữa quay lại trả lời bạn nhé.`; // i18n-allow: user-facing channel reply

export const AGENT_CHAT_DEDUP_REPLY = (botName: string): string =>
  `${botName} vẫn đang xử lý câu hỏi trước đó cho phòng này, chờ thêm chút nhé.`; // i18n-allow: user-facing channel reply

export const AGENT_CHAT_NO_DEVICE_REPLY = (botName: string): string =>
  `Xin lỗi, hiện không có runner nào sẵn sàng để ${botName} trả lời đầy đủ câu hỏi này — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export const AGENT_CHAT_FALLBACK_REPLY = (botName: string): string =>
  `Xin lỗi, ${botName} chưa tìm ra câu trả lời chắc chắn cho câu hỏi này — bạn hỏi lại giúp mình nhé.`; // i18n-allow: user-facing channel reply

export interface StartAgentChatArgs {
  projectId: string;
  project: { id: string; slug: string; repoPath: string | null };
  connectionId: string;
  rid: string;
  tmid?: string | undefined;
  botName: string;
  message: string;
  askedByUsername?: string | undefined;
  /**
   * Pre-built persona voice (`rocketChatPersona(...)`) — the caller
   * (`connection-manager.ts`) already builds this for the fast path, and
   * handing it in here (rather than this module importing
   * `connection-manager.ts` to build its own) keeps this module free of any
   * dependency back on its caller.
   */
  persona: string;
  /** Seeded recent-channel discussion — same block the fast path gets. */
  conversationContext?: string | null | undefined;
}

export type StartAgentChatResult =
  | { started: true; sessionId: string }
  | { started: false; reason: 'deduped' | 'no-device' | 'dispatch-failed' };

/**
 * DB-backed dedup: a `running` agent-chat session already tracks this room.
 * Mirrors `hasInFlightEscalation` — instance-independent, self-clears the
 * moment the session goes terminal via ANY writer.
 */
export async function hasInFlightAgentChat(projectId: string, rid: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.status, 'running'),
        sql`${agentSessions.metadata} -> 'agentChat' ->> 'rid' = ${rid}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The prompt driving the runner-hosted agent-chat session: persona voice +
 * seeded conversation + the user's message, with an explicit instruction that
 * this turn's reply is delivered to the room VERBATIM (unlike escalation,
 * there is no synthesis turn downstream to reshape it).
 */
export function buildAgentChatPrompt(args: {
  persona: string;
  conversationContext?: string | null | undefined;
  message: string;
  askedByUsername?: string | undefined;
}): string {
  const lines = [args.persona];
  const conversation = args.conversationContext?.trim();
  if (conversation) {
    lines.push(
      `Conversation context — the discussion that led to this message (if it references older matter, use the available history tools before concluding):\n${conversation}`,
    );
  }
  lines.push(`${args.askedByUsername ? `@${args.askedByUsername} asks: ` : ''}"${args.message}"`);
  lines.push(
    'Produce your FINAL user-facing reply now — it is delivered to the room verbatim, exactly as you write it. No fenced JSON, no meta-commentary about what you are about to do.',
  );
  return lines.join('\n\n');
}

/**
 * Dedup → resolve device → create session → dispatch. Returns without a
 * session on dedup/no-device (nothing to bridge later); on a dispatch throw,
 * the session is marked `failed` via `applyKernelTransition` — which fires
 * the completion bridge exactly like any other terminal writer, so the room
 * still gets one honest fallback reply asynchronously.
 */
export async function startAgentChat(args: StartAgentChatArgs): Promise<StartAgentChatResult> {
  if (await hasInFlightAgentChat(args.projectId, args.rid)) {
    return { started: false, reason: 'deduped' };
  }

  const client = await resolveChatDevice(
    { projectId: args.projectId, deviceId: null, metadata: null },
    undefined,
  );
  if (!client.deviceId) {
    return { started: false, reason: 'no-device' };
  }

  const session = await createChatSessionRow({
    projectId: args.projectId,
    userId: null,
    title: `Chat: ${args.message.slice(0, AGENT_CHAT_TITLE_MAX)}`,
    runKind: 'system',
    runMetadata: { source: 'rocketchat.agentChat', rid: args.rid },
    metadata: {
      agentChat: {
        connectionId: args.connectionId,
        rid: args.rid,
        tmid: args.tmid ?? null,
        botName: args.botName,
        askedByUsername: args.askedByUsername ?? null,
        question: args.message,
        deliveredAt: null,
      },
      lensOverride: ['product'],
    },
  });

  try {
    await dispatchChatTurn({
      session,
      project: args.project,
      client,
      message: buildAgentChatPrompt({
        persona: args.persona,
        conversationContext: args.conversationContext,
        message: args.message,
        askedByUsername: args.askedByUsername,
      }),
      forceLenses: ['product'],
      broadcastEvent: 'agent-session.created',
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, rid: args.rid },
      'rocketchat.agent-chat: chat-turn dispatch failed',
    );
    try {
      await applyKernelTransition(db, {
        entity: 'session',
        to: 'failed',
        set: { failureReason: 'ws-publish-failed' },
        where: eq(agentSessions.id, session.id),
        fromStatus: session.status,
        reason: 'ws-publish-failed',
        actor: { type: 'system' },
        source: 'rocketchat.agent-chat',
      });
    } catch (cleanupErr) {
      logger.error(
        { err: cleanupErr, sessionId: session.id },
        'rocketchat.agent-chat: failed to mark session failed after dispatch failure',
      );
    }
    return { started: false, reason: 'dispatch-failed' };
  }

  scheduleDelayedAck({
    sessionId: session.id,
    connectionId: args.connectionId,
    rid: args.rid,
    tmid: args.tmid ?? null,
    botName: args.botName,
  });

  return { started: true, sessionId: session.id };
}

/**
 * Post the interim "still working" ack ONLY if the turn is genuinely slow.
 * Fires once, `AGENT_CHAT_ACK_DELAY_MS` after dispatch; at fire time it
 * re-reads the session and posts the ack only when it is still `running`
 * AND the completion bridge has not already stamped `deliveredAt` (i.e. the
 * real answer hasn't landed). A fast turn therefore shows no ack at all —
 * the bridge delivers the answer before this timer fires and this no-ops.
 *
 * Best-effort by design: the timer is `unref()`-ed so it never keeps the
 * process alive, and a core restart inside the window simply drops the ack
 * (the answer is still delivered by the bridge on the terminal transition,
 * and a hung session is still reaped by the loop monitor). Errors are
 * swallowed — an undelivered ack must never surface as a failure.
 */
export function scheduleDelayedAck(args: {
  sessionId: string;
  connectionId: string;
  rid: string;
  tmid: string | null;
  botName: string;
}): void {
  const timer = setTimeout(() => {
    void postDelayedAck(args);
  }, AGENT_CHAT_ACK_DELAY_MS);
  // Don't let a pending ack timer keep the Node process alive on shutdown.
  timer.unref?.();
}

async function postDelayedAck(args: {
  sessionId: string;
  connectionId: string;
  rid: string;
  tmid: string | null;
  botName: string;
}): Promise<void> {
  try {
    const rows = await db
      .select({ status: agentSessions.status, metadata: agentSessions.metadata })
      .from(agentSessions)
      .where(eq(agentSessions.id, args.sessionId))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    // Turn already finished (any terminal status) — the bridge owns the reply.
    if (row.status !== 'running') return;
    // Answer already delivered by the bridge — no interim ack needed.
    const deliveredAt = (row.metadata as { agentChat?: { deliveredAt?: string | null } } | null)
      ?.agentChat?.deliveredAt;
    if (deliveredAt) return;

    const auth = await resolveRoomPostAuth(args.connectionId, { sessionId: args.sessionId });
    if (!auth) return;
    await postRoomMessage(auth, args.rid, AGENT_CHAT_ACK(args.botName), args.tmid ?? undefined);
  } catch (err) {
    logger.error(
      { err, sessionId: args.sessionId, rid: args.rid },
      'rocketchat.agent-chat: delayed ack post failed',
    );
  }
}
