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
  type ConversationVenue,
  codeAuthored,
  conversationTransport,
} from '../conversations/ports.js';
import { db } from '../db/client.js';
import { agentSessions, type MemberLens, projects } from '../db/schema.js';
import { buildProgressFactsBlock, computeProjectProgress } from '../issues/progress.js';
import { findAvailableDeviceForProject } from '../lib/device-pool.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import type { ProgressFacts } from '../messaging/facts.js';
import { createChatSessionRow, dispatchChatTurn, resolveChatDevice } from './chat-turn.js';

type SessionRow = typeof agentSessions.$inferSelect;

/** The metadata key a session carries when its answer belongs to a conversation. */
// cm:edge contract -> packages/core/src/agent-sessions/terminal-effects.ts — the terminal-session bridge list fans out on exactly this key, so a rename here without one there hangs every runner-hosted conversation reply silently.
export const CONVERSATION_AGENT_MARKER = 'conversationAgent';

const TITLE_MAX = 80;

/** What the venue is shown when this lane has no model answer to give it. */
// cm:guard the sentences are the CALLER's and not this module's, and that is what keeps one lane serving two venues: a Rocket.Chat room is answered in Vietnamese by a named bot and a Forge UI thread in English beside a state label, and a module holding both would be choosing between them on something it would have to be told anyway.
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
  deliveredAt: string | null;
  /** Which failure the venue was told about, stamped by the bridge; null while none. */
  failure: string | null;
  failover?: { attempt: number; triedDeviceIds: string[] } | undefined;
}

// cm:guard never coerce a missing field to a default — an absent venue or window means "not a conversation-agent session", and defaulting one turns that into a delivery attempt against a room nobody named.
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
    deliveredAt: typeof m.deliveredAt === 'string' ? m.deliveredAt : null,
    failure: typeof m.failure === 'string' ? m.failure : null,
    ...(m.failover ? { failover: m.failover as ConversationAgentMeta['failover'] } : {}),
  };
}

/**
 * At most one live runner-hosted turn per room.
 */
// cm:guard keyed on the CONVERSATION and never on a transport's room id: a Rocket.Chat thread and its parent channel are two conversations and may each hold a turn, while one browser room may not hold two — which is exactly what `projectId` + `rid` + `tmid` meant and could only say in one transport's terms (ISS-987's reason, ISS-1039's vocabulary).
// cm:guard DB-backed, never an in-memory Set: it must be instance-independent and self-clear the moment the session goes terminal by ANY writer.
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
// cm:guard `route-window.ts` asks this when it finds a reservation and no delivered row, which is the state a core that died between the dispatch and the close leaves behind: without it that window reopens as `undetermined` — "a reply was sent and never confirmed" — about an answer no session has written yet (ISS-1039, plan consult F5).
// cm:guard it does NOT filter on status: a window whose session has already finished is still a window that was handed off, and reading only the running ones would make the recovery answer depend on how long the crash lasted.
export async function conversationAgentTurnForWindow(
  windowId: string,
): Promise<{ sessionId: string } | null> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      sql`${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text ->> 'windowId' = ${windowId}`,
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
// cm:guard the four states are SERVED and never derived on the client, for the reason the membership capability is: the split between `dispatched` and `running` is a session's status and the split between `delivered` and `failed` is a metadata stamp, and a screen computing either would be guessing at rows it cannot see. A blank thread that means all four is this feature failing in the field, which is the whole of ISS-1039's screen rule.
export async function readConversationAgentTurns(
  conversationId: string,
): Promise<ConversationAgentTurnRow[]> {
  const rows = await db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
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
      // cm:guard `failure` and not the session's status decides between the last two: a session can end `completed` and still have produced nothing the screen could pass, and one that ended `failed` has had its reply delivered as the failure sentence — so what a person was SHOWN is the stamp the bridge wrote, not how the process exited.
      state: meta.failure
        ? 'failed'
        : meta.deliveredAt
          ? 'delivered'
          : row.status === 'running'
            ? 'running'
            : 'dispatched',
      reason: meta.failure,
    });
  }
  return out;
}

/**
 * Whether a box could take a turn for this project right now.
 */
// cm:guard the SAME resolver `startConversationAgentTurn` uses and not a second answer of its own:
// the composer offers Agent disabled on the strength of this, and a probe that disagreed with the
// dispatcher would either grey out a control that would have worked or offer one that refuses a
// second later — which is the lie ISS-1039 offers the disabled control to avoid.
// cm:guard it is a claim about NOW and never a guarantee: a device can go between this read and the
// send, which is why the send refuses by name rather than trusting it (ISS-1039).
export async function conversationAgentDeviceAvailable(projectId: string): Promise<boolean> {
  const client = await resolveChatDevice({ projectId, deviceId: null, metadata: null }, undefined);
  return Boolean(client.deviceId);
}

/**
 * Hand one conversation turn to a Claude Code session on a paired device.
 */
// cm:guard this module never delivers anything itself — `conversation-agent-bridge.ts` is the only path its output reaches a venue, and a post from here would race the bridge's at-most-once claim.
// cm:guard on a dispatch throw the session MUST be marked failed through `applyKernelTransition`: that fires the completion bridges like any other terminal writer, which is the only reason the venue still gets one honest sentence.
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

  // cm:why the snapshot NUMBERS are stored and not just the rendered block, so the bridge screens the reply against what this session was told rather than a fresh re-query that could skew if an issue closes mid-session (ISS-818).
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
 * Post an interim ack, but only if the turn is genuinely slow.
 */
// cm:guard best-effort by design: the timer is `unref`-ed and a core restart inside the window simply drops the ack, because the answer still arrives via the bridge and a hung session is still reaped by the loop monitor — an undelivered ack must never surface as a failure.
// cm:guard it is NOT recorded in the transcript: it is this handle saying it is working, not the answer, and a room's log holding it would make the eventual reply read as a second message about the same question.
// cm:guard a venue whose reader already sees the turn's state needs no ack at all, which is what a null `replies.ack` says: the Forge UI prints `dispatched` and `running` on the thread, so a sentence promising an answer would be the same fact twice (ISS-1039).
function scheduleAck(sessionId: string, marker: ConversationAgentMeta): void {
  if (!marker.replies.ack || marker.ackAfterMs === null) return;
  const timer = setTimeout(() => {
    void postAck(sessionId, marker);
  }, marker.ackAfterMs);
  timer.unref?.();
}

async function postAck(sessionId: string, marker: ConversationAgentMeta): Promise<void> {
  try {
    const [row] = await db
      .select({ status: agentSessions.status, metadata: agentSessions.metadata })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    if (row?.status !== 'running') return;
    if (readConversationAgentMeta(row.metadata)?.deliveredAt) return;
    const transport = conversationTransport(marker.venue.adapter);
    if (!transport || !marker.replies.ack) return;
    await transport.deliver(marker.venue, codeAuthored(marker.replies.ack));
  } catch (err) {
    logger.error({ err, sessionId }, 'conversation-agent: the interim ack could not be posted');
  }
}

/**
 * The prompt a runner-hosted conversation turn runs.
 */
// cm:guard it must keep telling the session its reply is delivered VERBATIM: there is no synthesis turn downstream to reshape it, unlike escalation.
// cm:why this lane does not go through `buildSystemPrompt`, so the progress block every other external turn gets is injected here by hand.
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

// cm:why mirrors `redispatchScheduleSessionOnFailover` (schedules/dispatch.ts) — that machinery is hard-gated to `metadata.source === 'schedule.run'`, so this lane needs its own.
const MAX_FAILOVERS = 2;

export type ConversationAgentFailoverResult =
  | { ok: true; sessionId: string; deviceId: string }
  | {
      ok: false;
      status: 'not-a-conversation-turn' | 'exhausted' | 'no-device' | 'no-prompt' | 'error';
    };

/**
 * Try another box for a turn whose runner failed on infrastructure.
 */
// cm:guard reuse the STORED prompt, never rebuild it: the stored text is exactly what `buildConversationAgentPrompt` produced for the first attempt, and the caller has already claimed `deliveredAt` so this cannot race a second failover for the same turn.
export async function redispatchConversationAgentTurn(
  session: SessionRow,
): Promise<ConversationAgentFailoverResult> {
  const meta = readConversationAgentMeta(session.metadata);
  if (!meta) return { ok: false, status: 'not-a-conversation-turn' };

  const prior = meta.failover ?? { attempt: 0, triedDeviceIds: [] };
  const tried = Array.from(
    new Set([...(prior.triedDeviceIds ?? []), session.deviceId].filter((d): d is string => !!d)),
  );
  const attempt = (prior.attempt ?? 0) + 1;
  if (attempt > MAX_FAILOVERS) return { ok: false, status: 'exhausted' };

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

  const priorMeta = (session.metadata as Record<string, unknown>) ?? {};
  const next: ConversationAgentMeta = {
    ...meta,
    deliveredAt: null,
    failure: null,
    failover: { attempt, triedDeviceIds: tried },
  };

  let retry: SessionRow;
  try {
    retry = await createChatSessionRow({
      projectId: session.projectId,
      userId: session.userId,
      title: session.title ?? `Chat: ${meta.question.slice(0, TITLE_MAX)}`,
      runKind: 'system',
      runMetadata: { source: 'conversation.agentTurn', conversationId: meta.conversationId },
      metadata: {
        [CONVERSATION_AGENT_MARKER]: next,
        ...(priorMeta.lensOverride ? { lensOverride: priorMeta.lensOverride } : {}),
        progressFacts: priorMeta.progressFacts ?? null,
      },
    });
  } catch (err) {
    logger.error(
      { err, failedSessionId: session.id, conversationId: meta.conversationId, attempt },
      'conversation-agent failover: retry session creation failed',
    );
    return { ok: false, status: 'error' };
  }

  try {
    const dispatched = await dispatchChatTurn({
      session: retry,
      project,
      client: { deviceId, isLocal: false, migrated: false },
      message: firstUser.content,
      ...(priorMeta.lensOverride
        ? { forceLenses: priorMeta.lensOverride as readonly MemberLens[] }
        : {}),
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
      'conversation-agent failover: re-dispatched to another runner',
    );
    return { ok: true, sessionId: dispatched.id, deviceId };
  } catch (err) {
    logger.error(
      { err, failedSessionId: session.id, retrySessionId: retry.id, attempt },
      'conversation-agent failover: re-dispatch failed',
    );
    // cm:edge lockstep -> packages/core/src/agent-sessions/conversation-agent-bridge.ts — `dispatchChatTurn` commits `status: 'running'` before its throwable work, so a throw here must terminate the retry row itself or `hasInFlightConversationAgentTurn` wedges the room on a phantom live turn.
    // cm:why `deliveredAt` is pre-stamped in the same write so the row the transition hands the bridge already has one — without it the bridge claims the retry row and posts a second failure sentence while the original caller posts one too.
    await markSessionFailed(retry, 'conversation-agent-failover', {
      ...next,
      deliveredAt: new Date().toISOString(),
    });
    return { ok: false, status: 'error' };
  }
}

async function markSessionFailed(
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
