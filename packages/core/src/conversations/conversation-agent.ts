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
  persistSessionAttachment,
  pickTurnCredentialDevice,
  resolveSessionAuthority,
  type SessionAsker,
  transitionSessions,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions, type MemberLens } from '../db/schema.js';
import { buildProgressFactsBlock, computeProjectProgress } from '../issues/index.js';
import { egressShown } from '../lib/data-egress.js';
import type { ProgressFacts } from '../messaging/facts.js';
import { logger } from '../observability/logger.js';
import { getStorage } from '../storage/index.js';
import { attachmentIdFromRef, loadConversationAttachment } from './attachment-service.js';
import { scheduleAck } from './conversation-agent-ack.js';
import {
  CONVERSATION_AGENT_MARKER,
  type ConversationAgentMeta,
  type ConversationAgentTurnArgs,
  type ConversationAgentTurnResult,
  readConversationAgentMeta,
} from './conversation-agent-meta.js';
import type { ConversationVenue } from './ports.js';
import type { ConversationImage } from './store.js';

type SessionRow = typeof agentSessions.$inferSelect;

export const TITLE_MAX = 80;

export {
  CONVERSATION_AGENT_MARKER,
  type ConversationAgentMeta,
  type ConversationAgentReplies,
  type ConversationAgentTurnArgs,
  type ConversationAgentTurnResult,
  readConversationAgentMeta,
} from './conversation-agent-meta.js';

/**
 * At most one live runner-hosted turn per room.
 */
export async function hasInFlightConversationAgentTurn(
  projectId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.status, 'running'),
        sql`${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'conversationId' = ${conversationId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The session already answering this window, if one was dispatched for it.
 */
export async function conversationAgentTurnForWindow(
  windowId: string,
): Promise<{ sessionId: string } | null> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        sql`${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'windowId' = ${windowId}`,
        sql`${agentSessions.startedAt} IS NOT NULL`,
      ),
    )
    .limit(1);
  return row ? { sessionId: row.id } : null;
}

/** What a person is told about a runner-hosted turn while it is not yet an answer. */
export type ConversationAgentTurnState = 'dispatched' | 'running' | 'delivered' | 'failed';

export interface ConversationAgentTurnRow {
  windowId: string;
  sessionId: string;
  state: ConversationAgentTurnState;
  /** On `failed` only: which failure it was, in the sentence the venue was shown. */
  reason: string | null;
}

/**
 * Every runner-hosted turn this room has held, newest last.
 */
export async function readConversationAgentTurns(
  conversationId: string,
): Promise<ConversationAgentTurnRow[]> {
  const rows = await db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      runtimeState: agentSessions.runtimeState,
      metadata: agentSessions.metadata,
      createdAt: agentSessions.createdAt,
    })
    .from(agentSessions)
    .where(
      sql`${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'conversationId' = ${conversationId}`,
    );
  const out: ConversationAgentTurnRow[] = [];
  for (const row of [...rows].sort((a, b) => +a.createdAt - +b.createdAt)) {
    const meta = readConversationAgentMeta(row.metadata);
    if (!meta) continue;
    out.push({
      windowId: meta.windowId,
      sessionId: row.id,
      state: turnState(row, meta),
      reason: meta.failure ?? (interruptedDelivery(meta) ? DELIVERY_INTERRUPTED : null),
    });
  }
  return out;
}

/**
 * How long a claimed-but-undelivered turn is read as being delivered rather than lost.
 */
const DELIVERY_INTERRUPTED_AFTER_MS = 10 * 60 * 1000;

/** What the venue is told when a delivery was claimed and then never finished. */
const DELIVERY_INTERRUPTED = 'the reply was interrupted before it reached this room';

function interruptedDelivery(meta: ConversationAgentMeta): boolean {
  if (meta.deliveredAt || meta.failure || !meta.claimedAt) return false;
  const at = Date.parse(meta.claimedAt);
  return Number.isFinite(at) && Date.now() - at > DELIVERY_INTERRUPTED_AFTER_MS;
}

export function turnState(
  row: { status: string; runtimeState: string | null },
  meta: ConversationAgentMeta,
): ConversationAgentTurnState {
  if (meta.failure) return 'failed';
  if (meta.deliveredAt) return 'delivered';
  if (interruptedDelivery(meta)) return 'failed';
  if (meta.claimedAt) return 'running';
  if (row.status !== 'running') return 'dispatched';
  return row.runtimeState ? 'running' : 'dispatched';
}

/**
 * Whether a box could take a turn for this project right now.
 */
export async function conversationAgentDeviceAvailable(projectId: string): Promise<boolean> {
  return (await conversationAgentUnavailableReason(projectId)) === null;
}

/** Why Agent mode cannot answer here right now, in a sentence; null where a box can. */
export async function conversationAgentUnavailableReason(
  projectId: string,
): Promise<string | null> {
  if (await pickTurnCredentialDevice(projectId)) return null;
  return (await noTurnCredentialDeviceReason(projectId)) === 'runner-outdated'
    ? 'the runners paired to this project are too old to act as the person asking; update forge-runner'
    : 'this project has no runner paired';
}

/**
 * Copy the room's pictures onto this turn's session, so the box that answers
 * can open them. A box reads session attachments and has no way to reach a
 * conversation's, so a turn dispatched without this copy answers a question
 * about a picture it was never shown.
 *
 * A picture that cannot be copied stops the turn rather than being left out:
 * an answer written without the file it was asked about is worse than no
 * answer, and the caller names the file in what it posts instead.
 */
async function carryImagesToSession(
  conversationId: string,
  sessionId: string,
  images: readonly ConversationImage[],
): Promise<{ ok: true; ids: string[] } | { ok: false; file: string }> {
  const ids: string[] = [];
  for (const image of images) {
    const attachmentId = attachmentIdFromRef(conversationId, image.ref);
    if (!attachmentId) return { ok: false, file: image.name };
    const row = await loadConversationAttachment(conversationId, attachmentId);
    if (!row) return { ok: false, file: image.name };
    try {
      const bytes = await getStorage().get(row.path);
      const copy = await persistSessionAttachment({
        sessionId,
        name: row.name,
        mime: row.mime,
        bytes,
        uploaderId: row.uploaderId,
        uploaderDeviceId: null,
      });
      ids.push(copy.id);
    } catch (err) {
      logger.error(
        { err, conversationId, sessionId, attachmentId },
        'conversation-agent: a picture could not be carried to the session',
      );
      return { ok: false, file: row.name };
    }
  }
  return { ok: true, ids };
}

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
  const progressFacts: ProgressFacts | null = progress
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
export function buildConversationAgentPrompt(args: {
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
