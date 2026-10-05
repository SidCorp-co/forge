/**
 * A conversation turn answered by a Claude Code session on a paired box, addressed by venue, window
 * and delivery key (ISS-1039). Nothing here names a transport: one lane serves every venue, because
 * a second copy per transport is the two-live-paths defect the conversation store was extracted to end.
 */

import { eq } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchChatTurn,
  mintSessionCredential,
  noTurnCredentialDeviceReason,
  pickTurnCredentialDevice,
  resolveSessionAuthority,
  transitionSessions,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions, type MemberLens } from '../db/schema.js';
import { buildProgressFactsBlock, computeProjectProgress } from '../issues/index.js';
import { egressShown } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
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
type Authorised = Extract<Awaited<ReturnType<typeof resolveSessionAuthority>>, { ok: true }>;

export const TITLE_MAX = 80;

/** The session row a runner-hosted conversation turn runs in, carrying its marker. */
export function createAgentSession(input: {
  projectId: string;
  userId: string;
  title: string;
  parentSessionId?: string;
  marker: ConversationAgentMeta;
  lensOverride?: unknown;
  progressFacts: unknown;
}): Promise<SessionRow> {
  return createChatSessionRow({
    projectId: input.projectId,
    userId: input.userId,
    title: input.title,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    runKind: 'system',
    runMetadata: { source: 'conversation.agentTurn', conversationId: input.marker.conversationId },
    metadata: {
      [CONVERSATION_AGENT_MARKER]: input.marker,
      ...(input.lensOverride ? { lensOverride: input.lensOverride } : {}),
      progressFacts: input.progressFacts ?? null,
    },
  });
}

/** Mint the asker's credential for this session and hand the turn to the box; the ack is then due. */
export async function dispatchAgentTurn(input: {
  session: SessionRow;
  project: { id: string; slug: string };
  deviceId: string;
  authorised: Authorised;
  message: string;
  marker: ConversationAgentMeta;
  attachmentIds?: string[];
  forceLenses?: readonly MemberLens[];
}): Promise<SessionRow> {
  const credential = await mintSessionCredential({
    sessionId: input.session.id,
    deviceId: input.deviceId,
    value: input.authorised.value,
  });
  const dispatched = await dispatchChatTurn({
    session: input.session,
    project: input.project,
    client: { deviceId: input.deviceId, isLocal: false, migrated: false },
    credential,
    message: input.message,
    ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
    ...(input.forceLenses ? { forceLenses: input.forceLenses } : {}),
    broadcastEvent: 'agent-session.created',
  });
  scheduleAck(dispatched.id, input.marker);
  return dispatched;
}

/** The marker a fresh turn's session carries: what the bridge needs to deliver its reply. */
function markerOf(
  args: ConversationAgentTurnArgs,
  asker: ConversationAgentMeta['asker'],
): ConversationAgentMeta {
  return {
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
}

export async function startConversationAgentTurn(
  args: ConversationAgentTurnArgs,
): Promise<ConversationAgentTurnResult> {
  const projectId = args.venue.projectId;
  if (await hasInFlightConversationAgentTurn(projectId, args.conversationId)) {
    return { started: false, reason: 'deduped' };
  }
  const spoken = await egressShown(
    projectId,
    'conversation',
    { question: args.question, conversationContext: args.conversationContext },
    `conversation ${args.conversationId}`,
  );
  const deviceId = await pickTurnCredentialDevice(projectId);
  if (!deviceId) return { started: false, reason: await noTurnCredentialDeviceReason(projectId) };
  const asker = { userId: args.asker.userId, viaTokenId: args.asker.viaTokenId };
  const authorised = await resolveSessionAuthority({ asker, projectId, deviceId });
  if (!authorised.ok) {
    return { started: false, reason: 'authority-refused', message: authorised.refusal.message };
  }

  const progress = await computeProjectProgress(projectId);
  const marker = markerOf(args, asker);
  const session = await createAgentSession({
    projectId,
    userId: asker.userId,
    title: `Chat: ${spoken.question.slice(0, TITLE_MAX)}`,
    marker,
    lensOverride: args.forceLenses ? [...args.forceLenses] : undefined,
    progressFacts: progress && {
      shipped: progress.shipped,
      closedUnshipped: progress.closedUnshipped,
      inFlight: progress.inFlight,
      remaining: progress.remaining,
      total: progress.total,
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
    await dispatchAgentTurn({
      session,
      project: args.project,
      deviceId,
      authorised,
      marker,
      attachmentIds: carried.ids,
      message: buildConversationAgentPrompt({
        persona: args.persona,
        conversationContext: spoken.conversationContext,
        question: spoken.question,
        askedByLabel: args.askedByLabel,
        progressFacts: progress ? buildProgressFactsBlock(progress) : null,
      }),
      ...(args.forceLenses ? { forceLenses: args.forceLenses } : {}),
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, conversationId: args.conversationId },
      'conversation-agent: chat-turn dispatch failed',
    );
    await markSessionFailed(session, 'conversation-agent');
    return { started: false, reason: 'dispatch-failed' };
  }
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
