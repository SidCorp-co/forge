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
import type { ConversationVenue } from '../conversations/ports.js';
import { db } from '../db/client.js';
import { agentSessions, type MemberLens } from '../db/schema.js';
import { buildProgressFactsBlock, computeProjectProgress } from '../issues/progress.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import type { ProgressFacts } from '../messaging/facts.js';
import { createChatSessionRow, dispatchChatTurn, resolveChatDevice } from './chat-turn.js';
import { scheduleAck } from './conversation-agent-ack.js';

type SessionRow = typeof agentSessions.$inferSelect;

/** The metadata key a session carries when its answer belongs to a conversation. */
export const CONVERSATION_AGENT_MARKER = 'conversationAgent';

export const TITLE_MAX = 80;

/** What the venue is shown when this lane has no model answer to give it. */
export interface ConversationAgentReplies {
  /** A turn is already running in this room. */
  dedup: string;
  /** No device could take it. */
  noDevice: string;
  /** It ran and produced nothing this venue can be shown. */
  failed: string;
  /** Posted only if the turn is still running after `ackAfterMs`; null sends none. */
  ack: string | null;
}

export interface ConversationAgentTurnArgs {
  venue: ConversationVenue;
  /** The room, its window, and the stable key this window's one delivery answers. */
  conversationId: string;
  windowId: string;
  deliveryKey: string;
  project: { id: string; slug: string; repoPath: string | null };
  /** The handle answering here — whose voice the code-authored sentences speak in. */
  handleName: string;
  /** Everything the window collected, as one body. */
  question: string;
  askedByLabel?: string | null | undefined;
  persona: string;
  conversationContext?: string | null | undefined;
  /** Where the reply is screened when it comes back. */
  door: 'agent-chat-completion' | 'web-agent-completion';
  replies: ConversationAgentReplies;
  /** How long a still-running turn waits before its ack is posted; null posts none. */
  ackAfterMs?: number | null | undefined;
  /** The chat voice this session's cold-start preamble is pinned to. */
  forceLenses?: readonly MemberLens[] | null | undefined;
}

export type ConversationAgentTurnResult =
  | { started: true; sessionId: string }
  | { started: false; reason: 'deduped' | 'no-device' | 'dispatch-failed' };

/** What a session carries about the conversation turn it is answering. */
export interface ConversationAgentMeta {
  venue: ConversationVenue;
  conversationId: string;
  windowId: string;
  deliveryKey: string;
  handleName: string;
  question: string;
  askedByLabel: string | null;
  door: 'agent-chat-completion' | 'web-agent-completion';
  replies: ConversationAgentReplies;
  ackAfterMs: number | null;
  /**
   * When the bridge took this turn's delivery, which is NOT when it was delivered.
   */
  claimedAt: string | null;
  deliveredAt: string | null;
  /** Which failure the venue was told about, stamped by the bridge; null while none. */
  failure: string | null;
  failover?: { attempt: number; triedDeviceIds: string[] } | undefined;
}

export function readConversationAgentMeta(metadata: unknown): ConversationAgentMeta | null {
  const raw = (metadata as Record<string, unknown> | null)?.[CONVERSATION_AGENT_MARKER];
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const venue = m.venue as ConversationVenue | undefined;
  if (
    !venue ||
    typeof venue.adapter !== 'string' ||
    typeof venue.externalId !== 'string' ||
    typeof venue.projectId !== 'string' ||
    typeof m.conversationId !== 'string' ||
    typeof m.windowId !== 'string' ||
    typeof m.deliveryKey !== 'string'
  ) {
    return null;
  }
  const replies = (m.replies ?? {}) as Record<string, unknown>;
  return {
    venue,
    conversationId: m.conversationId,
    windowId: m.windowId,
    deliveryKey: m.deliveryKey,
    handleName: typeof m.handleName === 'string' ? m.handleName : '',
    question: typeof m.question === 'string' ? m.question : '',
    askedByLabel: typeof m.askedByLabel === 'string' ? m.askedByLabel : null,
    door: m.door === 'web-agent-completion' ? 'web-agent-completion' : 'agent-chat-completion',
    replies: {
      dedup: typeof replies.dedup === 'string' ? replies.dedup : '',
      noDevice: typeof replies.noDevice === 'string' ? replies.noDevice : '',
      failed: typeof replies.failed === 'string' ? replies.failed : '',
      ack: typeof replies.ack === 'string' ? replies.ack : null,
    },
    ackAfterMs: typeof m.ackAfterMs === 'number' ? m.ackAfterMs : null,
    claimedAt:
      typeof m.claimedAt === 'string'
        ? m.claimedAt
        : typeof m.deliveredAt === 'string'
          ? m.deliveredAt
          : null,
    deliveredAt: typeof m.deliveredAt === 'string' ? m.deliveredAt : null,
    failure: typeof m.failure === 'string' ? m.failure : null,
    ...(m.failover ? { failover: m.failover as ConversationAgentMeta['failover'] } : {}),
  };
}

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

function turnState(
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
  const client = await resolveChatDevice({ projectId, deviceId: null, metadata: null }, undefined);
  return Boolean(client.deviceId);
}

export async function startConversationAgentTurn(
  args: ConversationAgentTurnArgs,
): Promise<ConversationAgentTurnResult> {
  if (await hasInFlightConversationAgentTurn(args.venue.projectId, args.conversationId)) {
    return { started: false, reason: 'deduped' };
  }

  const client = await resolveChatDevice(
    { projectId: args.venue.projectId, deviceId: null, metadata: null },
    undefined,
  );
  if (!client.deviceId) return { started: false, reason: 'no-device' };

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
    door: args.door,
    replies: args.replies,
    ackAfterMs: args.ackAfterMs ?? null,
    claimedAt: null,
    deliveredAt: null,
    failure: null,
  };

  const session = await createChatSessionRow({
    projectId: args.venue.projectId,
    userId: null,
    title: `Chat: ${args.question.slice(0, TITLE_MAX)}`,
    runKind: 'system',
    runMetadata: { source: 'conversation.agentTurn', conversationId: args.conversationId },
    metadata: {
      [CONVERSATION_AGENT_MARKER]: marker,
      ...(args.forceLenses ? { lensOverride: [...args.forceLenses] } : {}),
      progressFacts,
    },
  });

  try {
    await dispatchChatTurn({
      session,
      project: args.project,
      client,
      message: buildConversationAgentPrompt({
        persona: args.persona,
        conversationContext: args.conversationContext,
        question: args.question,
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
    await applyKernelTransition(db, {
      entity: 'session',
      to: 'failed',
      set: {
        failureReason: 'ws_publish_failed',
        ...(marker
          ? { metadata: { ...priorMeta, [CONVERSATION_AGENT_MARKER]: marker } as never }
          : {}),
      },
      where: eq(agentSessions.id, session.id),
      fromStatus: session.status,
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
