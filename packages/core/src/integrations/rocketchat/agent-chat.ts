/**
 * ISS-727 — `agent`-mode dispatcher. When a project's answer-mode is `agent`,
 * EVERY real turn routes here instead of the fast provider-chat path and runs
 * as a runner-hosted `system` session; the reply arrives via
 * `agent-chat-bridge.ts`. Differs from `escalation.ts` only in prompt shape
 * and dedup marker.
 */
// cm:guard this module never posts to the room itself — the bridge is the only path its output reaches a channel

import { eq } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchChatTurn,
  resolveChatDevice,
} from '../../agent-sessions/chat-turn.js';
import { db } from '../../db/client.js';
import { agentSessions, projects } from '../../db/schema.js';
import { buildProgressFactsBlock, computeProjectProgress } from '../../issues/progress.js';
import { findAvailableDeviceForProject } from '../../lib/device-pool.js';
import { applyKernelTransition } from '../../lifecycle/transition.js';
import { logger } from '../../logger.js';
import { FIXED_REPLY_CONSTANT, sendFixedReply } from './outbound.js';
import type { ProgressFacts } from './reply-guard.js';
import { hasInFlightRoomSession, resolveRoomPostAuth } from './room-delivery.js';

type SessionRow = typeof agentSessions.$inferSelect;

const AGENT_CHAT_TITLE_MAX = 80;

// cm:guard under this delay the room sees NO ack at all — the bridge delivers the real answer first, which is the common case; only a genuinely slow turn ever shows one
export const AGENT_CHAT_ACK_DELAY_MS = 2 * 60 * 1000;

export const AGENT_CHAT_ACK = (botName: string): string =>
  `${botName} đang xử lý câu hỏi này qua trợ lý đầy đủ, lát nữa quay lại trả lời bạn nhé.`; // i18n-allow: user-facing channel reply

export const AGENT_CHAT_DEDUP_REPLY = (botName: string): string =>
  `${botName} vẫn đang xử lý câu hỏi trước đó cho phòng này, chờ thêm chút nhé.`; // i18n-allow: user-facing channel reply

export const AGENT_CHAT_NO_DEVICE_REPLY = (botName: string): string =>
  `Xin lỗi, hiện không có runner nào sẵn sàng để ${botName} trả lời đầy đủ câu hỏi này — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

// cm:why ISS-818 — states WHY (figures unreconciled), not a bare "couldn't verify" that reads as "didn't understand you" and sends the user off to rephrase
export const AGENT_CHAT_FALLBACK_REPLY = (botName: string): string =>
  `Xin lỗi, ${botName} chưa đối chiếu được số liệu dự án nên không dám gửi câu trả lời chưa chắc chắn — không phải do câu hỏi của bạn, bạn hỏi lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export interface StartAgentChatArgs {
  projectId: string;
  project: { id: string; slug: string; repoPath: string | null };
  connectionId: string;
  rid: string;
  tmid?: string | undefined;
  botName: string;
  message: string;
  askedByUsername?: string | undefined;
  // cm:guard the persona is passed IN, never built here — importing connection-manager.ts for it would create a dependency back on this module's own caller
  persona: string;
  conversationContext?: string | null | undefined;
}

export type StartAgentChatResult =
  | { started: true; sessionId: string }
  | { started: false; reason: 'deduped' | 'no-device' | 'dispatch-failed' };

export function hasInFlightAgentChat(projectId: string, rid: string): Promise<boolean> {
  return hasInFlightRoomSession(projectId, rid, 'agentChat');
}

// cm:guard the prompt must keep telling the session its reply is delivered VERBATIM — there is no synthesis turn downstream to reshape it, unlike escalation
export function buildAgentChatPrompt(args: {
  persona: string;
  conversationContext?: string | null | undefined;
  message: string;
  askedByUsername?: string | undefined;
  // cm:why agent mode does not go through buildSystemPrompt, so the progress block every other external turn gets has to be injected here by hand
  progressFacts?: string | null | undefined;
}): string {
  const lines = [args.persona];
  const conversation = args.conversationContext?.trim();
  if (conversation) {
    lines.push(
      `Conversation context — the discussion that led to this message (if it references older matter, use the available history tools before concluding):\n${conversation}`,
    );
  }
  const progressFacts = args.progressFacts?.trim();
  if (progressFacts) {
    lines.push(progressFacts);
  }
  lines.push(`${args.askedByUsername ? `@${args.askedByUsername} asks: ` : ''}"${args.message}"`);
  lines.push(
    'Produce your FINAL user-facing reply now — it is delivered to the room verbatim, exactly as you write it. No fenced JSON, no meta-commentary about what you are about to do.',
  );
  return lines.join('\n\n');
}

// cm:guard on a dispatch throw the session MUST be marked failed via applyKernelTransition — that fires the completion bridge like any other terminal writer, which is the only reason the room still gets one honest fallback
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

  // cm:why store the snapshot NUMBERS on metadata (not just the rendered prompt block) so agent-chat-bridge.ts screens the reply against what this session was actually told, not a fresh re-query that could skew if an issue closes mid-session
  const progress = await computeProjectProgress(args.projectId);
  const progressFacts: ProgressFacts | null = progress
    ? {
        shipped: progress.shipped,
        closedUnshipped: progress.closedUnshipped,
        inFlight: progress.inFlight,
        remaining: progress.remaining,
        total: progress.total,
      }
    : null;

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
      progressFacts,
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
        progressFacts: progress ? buildProgressFactsBlock(progress) : null,
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
        set: { failureReason: 'ws_publish_failed' },
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

// cm:why mirrors redispatchScheduleSessionOnFailover (schedules/dispatch.ts) — that machinery is hard-gated to metadata.source==='schedule.run', so agent-chat needs its own copy
const MAX_AGENT_CHAT_FAILOVERS = 2;

interface AgentChatFailoverState {
  attempt: number;
  triedDeviceIds: string[];
}

export type AgentChatFailoverResult =
  | { ok: true; status: 'redispatched'; sessionId: string; deviceId: string }
  | { ok: false; status: 'not-agent-chat' | 'exhausted' | 'no-device' | 'no-prompt' | 'error' };

// cm:guard reuse the STORED prompt, never rebuild it — the stored text is exactly what buildAgentChatPrompt produced for the first attempt, and the caller has already CAS-claimed deliveredAt so this cannot race a second failover for the same turn
export async function redispatchAgentChatSessionOnFailover(
  session: SessionRow,
): Promise<AgentChatFailoverResult> {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  const agentChat = meta.agentChat as Record<string, unknown> | undefined;
  if (
    !agentChat ||
    typeof agentChat.connectionId !== 'string' ||
    typeof agentChat.rid !== 'string' ||
    typeof agentChat.botName !== 'string'
  ) {
    return { ok: false, status: 'not-agent-chat' };
  }

  const prior = (agentChat.failover as AgentChatFailoverState | undefined) ?? {
    attempt: 0,
    triedDeviceIds: [],
  };
  const tried = Array.from(
    new Set([...(prior.triedDeviceIds ?? []), session.deviceId].filter((d): d is string => !!d)),
  );
  const attempt = (prior.attempt ?? 0) + 1;
  if (attempt > MAX_AGENT_CHAT_FAILOVERS) return { ok: false, status: 'exhausted' };

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const firstUser = messages.find(
    (m): m is { role: string; content: string } =>
      !!m &&
      (m as { role?: string }).role === 'user' &&
      typeof (m as { content?: unknown }).content === 'string',
  );
  if (!firstUser) return { ok: false, status: 'no-prompt' };

  const deviceId = await findAvailableDeviceForProject(session.projectId, {
    excludeDeviceIds: tried,
  });
  if (!deviceId) return { ok: false, status: 'no-device' };

  const [project] = await db
    .select({ id: projects.id, slug: projects.slug, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, session.projectId))
    .limit(1);
  if (!project) return { ok: false, status: 'error' };

  const nextAgentChat = {
    ...agentChat,
    deliveredAt: null,
    failover: { attempt, triedDeviceIds: tried } satisfies AgentChatFailoverState,
  };

  let retrySession: SessionRow;
  try {
    retrySession = await createChatSessionRow({
      projectId: session.projectId,
      userId: session.userId,
      title:
        session.title ?? `Chat: ${String(agentChat.question ?? '').slice(0, AGENT_CHAT_TITLE_MAX)}`,
      runKind: 'system',
      runMetadata: { source: 'rocketchat.agentChat', rid: agentChat.rid },
      metadata: {
        agentChat: nextAgentChat,
        lensOverride: ['product'],
        progressFacts: meta.progressFacts ?? null,
      },
    });
  } catch (err) {
    logger.error(
      { err, failedSessionId: session.id, rid: agentChat.rid, attempt },
      'agent-chat failover: retry session creation failed',
    );
    return { ok: false, status: 'error' };
  }

  try {
    const dispatched = await dispatchChatTurn({
      session: retrySession,
      project,
      client: { deviceId, isLocal: false, migrated: false },
      message: firstUser.content,
      forceLenses: ['product'],
      broadcastEvent: 'agent-session.created',
    });
    logger.info(
      {
        failedSessionId: session.id,
        retrySessionId: dispatched.id,
        fromDeviceId: session.deviceId,
        toDeviceId: deviceId,
        failureReason: session.failureReason,
        attempt,
      },
      'agent-chat failover: re-dispatched to another runner',
    );
    scheduleDelayedAck({
      sessionId: dispatched.id,
      connectionId: agentChat.connectionId as string,
      rid: agentChat.rid as string,
      tmid: typeof agentChat.tmid === 'string' ? agentChat.tmid : null,
      botName: agentChat.botName as string,
    });
    return { ok: true, status: 'redispatched', sessionId: dispatched.id, deviceId };
  } catch (err) {
    logger.error(
      {
        err,
        failedSessionId: session.id,
        retrySessionId: retrySession.id,
        rid: agentChat.rid,
        attempt,
      },
      'agent-chat failover: re-dispatch failed',
    );
    // cm:edge lockstep -> packages/core/src/integrations/rocketchat/agent-chat-bridge.ts — dispatchChatTurn commits status:'running' before its throwable work, so a throw here must terminate the retry row itself (mirrors startAgentChat's catch above) or hasInFlightAgentChat wedges the room on a phantom in-flight session
    // cm:why pre-stamp deliveredAt in the same write so the row applyKernelTransition returns to fireAgentChatBridge already has a non-null deliveredAt — without this the bridge CAS-claims the retry row and posts a second fallback while the original caller also posts one
    const retryMeta = (retrySession.metadata as Record<string, unknown>) ?? {};
    const retryAgentChat = (retryMeta.agentChat as Record<string, unknown>) ?? {};
    try {
      await applyKernelTransition(db, {
        entity: 'session',
        to: 'failed',
        set: {
          failureReason: 'ws_publish_failed',
          metadata: {
            ...retryMeta,
            agentChat: { ...retryAgentChat, deliveredAt: new Date().toISOString() },
          } as never,
        },
        where: eq(agentSessions.id, retrySession.id),
        fromStatus: retrySession.status,
        reason: 'ws-publish-failed',
        actor: { type: 'system' },
        source: 'rocketchat.agent-chat',
      });
    } catch (cleanupErr) {
      logger.error(
        { err: cleanupErr, retrySessionId: retrySession.id },
        'agent-chat failover: failed to mark retry session failed after dispatch failure',
      );
    }
    return { ok: false, status: 'error' };
  }
}

// cm:guard best-effort by design: the timer is unref()-ed and a core restart inside the window simply drops the ack, because the answer still arrives via the bridge and a hung session is still reaped by the loop monitor — an undelivered ack must never surface as a failure
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
    if (row.status !== 'running') return;
    const deliveredAt = (row.metadata as { agentChat?: { deliveredAt?: string | null } } | null)
      ?.agentChat?.deliveredAt;
    if (deliveredAt) return;

    const auth = await resolveRoomPostAuth(args.connectionId, { sessionId: args.sessionId });
    if (!auth) return;
    await sendFixedReply(
      { kind: 'rest', auth, rid: args.rid, tmid: args.tmid ?? undefined },
      AGENT_CHAT_ACK(args.botName),
      FIXED_REPLY_CONSTANT,
    );
  } catch (err) {
    logger.error(
      { err, sessionId: args.sessionId, rid: args.rid },
      'rocketchat.agent-chat: delayed ack post failed',
    );
  }
}
