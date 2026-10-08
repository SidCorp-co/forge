/**
 * A conversation turn answered by a Claude Code session on a paired box, addressed by venue, window
 * and delivery key (ISS-1039). Nothing here names a transport: one lane serves every venue, because
 * a second copy per transport is the two-live-paths defect the conversation store was extracted to end.
 */

import type { FailureCause } from '@forge/contracts/failure-causes';
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
import { isRefusal } from '../lib/refusal.js';
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

/** Why a turn never reached its box, as its session's failure reason records it. */
type NotDispatched = Extract<
  FailureCause,
  | 'checkout_unbound'
  | 'credential_mint_failed'
  | 'attachment_unreadable'
  | 'box_cannot_confine_chat'
  | 'dispatch_failed'
>;

const NOT_DISPATCHED = Symbol('notDispatched');

/** An invariant break that carries the cause its session is failed with. */
function notDispatched(failureCause: NotDispatched, cause: unknown): Error {
  return Object.assign(
    new Error(`conversation-agent: the turn was not handed to its box (${failureCause})`, {
      cause,
    }),
    { [NOT_DISPATCHED]: failureCause },
  );
}

/**
 * The real cause of a dispatch that threw: the binding, the credential, a box that cannot confine a
 * chat, or the hand-over itself.
 */
export function notDispatchedCause(err: unknown): NotDispatched {
  const carried = (err as { [NOT_DISPATCHED]?: NotDispatched } | null)?.[NOT_DISPATCHED];
  if (carried) return carried;
  if (isRefusal(err, 'CHECKOUT_UNBOUND')) return 'checkout_unbound';
  if (isRefusal(err, 'BOX_CANNOT_CONFINE_CHAT')) return 'box_cannot_confine_chat';
  return 'dispatch_failed';
}

/** The refusal's own sentence where the box cannot confine a chat: it names the box and why. */
export function cannotConfineSentence(err: unknown): string | null {
  if (!isRefusal(err, 'BOX_CANNOT_CONFINE_CHAT')) return null;
  return err.refusals.find((r) => r.code === 'BOX_CANNOT_CONFINE_CHAT')?.detail ?? null;
}

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

/** The asker's credential for this session; a mint that throws is the turn's cause of failure. */
export function mintTurnCredential(
  input: Parameters<typeof mintSessionCredential>[0],
): ReturnType<typeof mintSessionCredential> {
  return mintSessionCredential(input).catch((err: unknown) => {
    throw notDispatched('credential_mint_failed', err);
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
  const credential = await mintTurnCredential({
    sessionId: input.session.id,
    deviceId: input.deviceId,
    value: input.authorised.value,
  });
  const dispatched = await dispatchChatTurn({
    session: input.session,
    project: input.project,
    client: { deviceId: input.deviceId, migrated: false },
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
    staged: [],
    droppedBlocks: [],
    images: [...(args.images ?? [])],
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
    // the room is told by the caller, naming the file; the stamped marker keeps the bridge
    // from posting a second, different reply under the same delivery key
    const at = new Date().toISOString();
    await markSessionFailed(session, 'conversation-agent', 'attachment_unreadable', {
      ...marker,
      claimedAt: at,
      deliveredAt: at,
      failure: `the file ${carried.file} could not be carried to the session`,
    });
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
    const cannotConfine = cannotConfineSentence(err);
    if (cannotConfine) {
      // refused by name before anything ran: the caller tells the room, and the stamped marker keeps
      // the bridge from failing it over or posting a second reply under the same delivery key
      const at = new Date().toISOString();
      await markSessionFailed(session, 'conversation-agent', 'box_cannot_confine_chat', {
        ...marker,
        claimedAt: at,
        deliveredAt: at,
        failure: cannotConfine,
      });
      return { started: false, reason: 'box-cannot-confine', message: cannotConfine };
    }
    logger.error(
      { err, sessionId: session.id, conversationId: args.conversationId },
      'conversation-agent: chat-turn dispatch failed',
    );
    await markSessionFailed(session, 'conversation-agent', notDispatchedCause(err));
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

/** Fail a session whose turn never reached its box, under the cause that stopped it. */
export async function markSessionFailed(
  session: SessionRow,
  source: string,
  cause: NotDispatched,
  marker?: ConversationAgentMeta,
): Promise<void> {
  try {
    const priorMeta = (session.metadata as Record<string, unknown>) ?? {};
    await transitionSessions(db, {
      to: 'failed',
      set: {
        failureReason: cause,
        ...(marker
          ? { metadata: { ...priorMeta, [CONVERSATION_AGENT_MARKER]: marker } as never }
          : {}),
      },
      where: eq(agentSessions.id, session.id),
      reason: cause,
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
