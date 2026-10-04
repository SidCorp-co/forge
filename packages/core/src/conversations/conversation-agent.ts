/**
 * A conversation turn answered by a Claude Code session on a paired box.
 *
 * ISS-727 built this for Rocket.Chat and built it in Rocket.Chat's vocabulary:
 * a connection id, a room id, a thread id and a bot name. ISS-1039 makes the
 * same lane the Forge UI's Agent mode, so what a turn is about here is a VENUE,
 * a window and a delivery key — the three things `conversations/ports.ts`
 * already addresses a room by — and the reply goes out through that venue's own
 * transport rather than through one transport's REST client.
 *
 * Nothing in this file names a transport. A second copy of it parameterised for
 * `web` is the two-live-paths defect the conversation store was extracted to
 * end, which is why there is one.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchChatTurn,
  mintSessionCredential,
  noTurnCredentialDeviceReason,
  pickTurnCredentialDevice,
  resolveSessionAuthority,
  type SessionAsker,
  transitionSessions,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { buildProgressFactsBlock, computeProjectProgress } from '../issues/index.js';
import { egressShown } from '../lib/data-egress.js';
import { logger } from '../observability/logger.js';
import { scheduleAck } from './conversation-agent-ack.js';
import { carryImagesToSession } from './conversation-agent-images.js';
import {
  CONVERSATION_AGENT_MARKER,
  type ConversationAgentMeta,
  type ConversationAgentTurnArgs,
  type ConversationAgentTurnResult,
} from './conversation-agent-meta.js';
import { hasInFlightConversationAgentTurn } from './conversation-agent-read.js';

type SessionRow = typeof agentSessions.$inferSelect;

export const TITLE_MAX = 80;

export async function startConversationAgentTurn(
  args: ConversationAgentTurnArgs,
): Promise<ConversationAgentTurnResult> {
  if (await hasInFlightConversationAgentTurn(args.venue.projectId, args.conversationId)) {
    return { started: false, reason: 'deduped' };
  }

  const spoken = await egressShown(
    args.venue.projectId,
    'conversation',
    { question: args.question, conversationContext: args.conversationContext },
    `conversation ${args.conversationId}`,
  );
  const deviceId = await pickTurnCredentialDevice(args.venue.projectId);
  if (!deviceId) {
    return { started: false, reason: await noTurnCredentialDeviceReason(args.venue.projectId) };
  }
  const asker: SessionAsker = { userId: args.asker.userId, viaTokenId: args.asker.viaTokenId };
  const authorised = await resolveSessionAuthority({
    asker,
    projectId: args.venue.projectId,
    deviceId,
  });
  if (!authorised.ok) {
    return { started: false, reason: 'authority-refused', message: authorised.refusal.message };
  }

  const progress = await computeProjectProgress(args.venue.projectId);
  const progressFacts = progress
    ? {
        shipped: progress.shipped,
        closedUnshipped: progress.closedUnshipped,
        inFlight: progress.inFlight,
        remaining: progress.remaining,
        total: progress.total,
      }
    : null;

  const marker: ConversationAgentMeta = {
    venue: args.venue,
    conversationId: args.conversationId,
    windowId: args.windowId,
    deliveryKey: args.deliveryKey,
    handleName: args.handleName,
    question: args.question,
    askedByLabel: args.askedByLabel ?? null,
    asker,
    door: args.door,
    replies: args.replies,
    ackAfterMs: args.ackAfterMs ?? null,
    claimedAt: null,
    deliveredAt: null,
    failure: null,
  };

  const session = await createChatSessionRow({
    projectId: args.venue.projectId,
    userId: asker.userId,
    title: `Chat: ${spoken.question.slice(0, TITLE_MAX)}`,
    runKind: 'system',
    runMetadata: { source: 'conversation.agentTurn', conversationId: args.conversationId },
    metadata: {
      [CONVERSATION_AGENT_MARKER]: marker,
      ...(args.forceLenses ? { lensOverride: [...args.forceLenses] } : {}),
      progressFacts,
    },
  });

  const carried = args.images?.length
    ? await carryImagesToSession(args.conversationId, session.id, args.images)
    : { ok: true as const, ids: [] };
  if (!carried.ok) {
    await markSessionFailed(session, 'conversation-agent');
    return { started: false, reason: 'attachment-unreadable', file: carried.file };
  }

  try {
    const credential = await mintSessionCredential({
      sessionId: session.id,
      deviceId,
      value: authorised.value,
    });
    await dispatchChatTurn({
      session,
      project: args.project,
      client: { deviceId, isLocal: false, migrated: false },
      credential,
      ...(carried.ids.length ? { attachmentIds: carried.ids } : {}),
      message: buildConversationAgentPrompt({
        persona: args.persona,
        conversationContext: spoken.conversationContext,
        question: spoken.question,
        askedByLabel: args.askedByLabel,
        progressFacts: progress ? buildProgressFactsBlock(progress) : null,
      }),
      ...(args.forceLenses ? { forceLenses: args.forceLenses } : {}),
      broadcastEvent: 'agent-session.created',
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, conversationId: args.conversationId },
      'conversation-agent: chat-turn dispatch failed',
    );
    await markSessionFailed(session, 'conversation-agent');
    return { started: false, reason: 'dispatch-failed' };
  }

  scheduleAck(session.id, marker);
  return { started: true, sessionId: session.id };
}

/**
 * The prompt a runner-hosted conversation turn runs.
 */
function buildConversationAgentPrompt(args: {
  persona: string;
  conversationContext?: string | null | undefined;
  question: string;
  askedByLabel?: string | null | undefined;
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
  if (progressFacts) lines.push(progressFacts);
  lines.push(`${args.askedByLabel ? `${args.askedByLabel} asks: ` : ''}"${args.question}"`);
  lines.push(
    'Produce your FINAL user-facing reply now — it is delivered to the room verbatim, exactly as you write it. No fenced JSON, no meta-commentary about what you are about to do.',
  );
  return lines.join('\n\n');
}

export async function markSessionFailed(
  session: SessionRow,
  source: string,
  marker?: ConversationAgentMeta,
): Promise<void> {
  try {
    const priorMeta = (session.metadata as Record<string, unknown>) ?? {};
    await transitionSessions(db, {
      to: 'failed',
      set: {
        failureReason: 'ws_publish_failed',
        ...(marker
          ? { metadata: { ...priorMeta, [CONVERSATION_AGENT_MARKER]: marker } as never }
          : {}),
      },
      where: eq(agentSessions.id, session.id),
      reason: 'ws-publish-failed',
      actor: { type: 'system' },
      source,
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id },
      'conversation-agent: marking the session failed after a dispatch failure failed',
    );
  }
}
