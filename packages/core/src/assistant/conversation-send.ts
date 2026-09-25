/**
 * A message typed in the Forge UI, taken in and then answered.
 *
 * The two halves are the two ISS-1004 built for the first adapter and this one
 * reuses whole: `collectInboundMessage` puts the message and its collector
 * window in the log under one commit, and `routeWindow` takes the decision and
 * writes down what it was. Nothing between them is web-specific except the turn
 * inputs — the persona and the toolset — which is exactly the claim ISS-1002
 * made about what an adapter owes a turn.
 *
 * What a restart is owed — a window opened by a send whose core died is still a
 * question somebody asked — is `conversation-drain.ts`, which calls
 * `routeWebWindow` below for a window it claims by adapter rather than by room.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { collectInboundMessage } from '../conversations/collect-inbound.js';
import { type ProjectHandle, resolveProjectHandle } from '../conversations/handles.js';
import { type ConversationVenue, codeAuthored } from '../conversations/ports.js';
import { routeWindow, type WindowTurnInputs } from '../conversations/route-window.js';
import {
  type ConversationImage,
  effectiveConversationMode,
  getConversation,
  readMessages,
  settleConversationMode,
} from '../conversations/store.js';
import {
  type ConversationWindowRow,
  claimDueWindows,
  claimOf,
  releaseWindow,
  type WindowClaim,
} from '../conversations/windows.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import type { ConversationMode, ConversationShape } from '../db/schema-conversations.js';
import { logger } from '../logger.js';
import {
  publishToConversationReaders,
  WEB_CONVERSATION_ACCEPTED_EVENT,
  WEB_CONVERSATION_SETTLED_EVENT,
  type WebConversationFrame,
  webConversationPorts,
} from './conversation-adapter.js';
import { makeConversationImageResolver } from './conversation-images.js';
import { type ConversationProgress, startConversationProgress } from './conversation-progress.js';
import { registerTurnStop } from './conversation-stops.js';
import { webAgentConversationPersona, webConversationPersona } from './door-persona.js';
import { buildChatToolContext } from './tools/principal.js';
import { buildProjectToolset } from './tools/registry.js';

/** The room a send happens in, as the route already read it. */
export interface WebConversationRoom {
  id: string;
  externalId: string;
  shape: ConversationShape;
}

/**
 * What the Forge UI contributes to a turn: who the assistant is, and what it may read.
 */
export function webConversationTurn(args: {
  project: { id: string; slug: string; name: string; repoPath: string | null };
  handleName: string;
  askedBy: string | null;
  /** The window this turn answers, for the diversion that answers later. */
  window: {
    venue: ConversationVenue;
    conversationId: string;
    windowId: string;
    deliveryKey: string;
    mode: ConversationMode;
    question: string;
    /** The pictures this window's messages carry, for a turn answered on a box. */
    images: readonly ConversationImage[];
    /**
     * What was said in this room BEFORE this window, for a turn answered out of reach.
     */
    conversationContext: () => Promise<string | null>;
    reserve: () => Promise<boolean>;
  };
  /**
   * The watcher this turn publishes to while it runs.
   */
  progress: ConversationProgress;
  /** A person ending this turn from the room it runs in. */
  externalStop: AbortSignal;
}): WindowTurnInputs {
  return {
    door: 'web-chat-reply',
    externalStop: args.externalStop,
    handleName: args.handleName,
    log: { adapter: 'web', projectId: args.project.id, mode: args.window.mode },

    onTurnEvent: args.progress.onTurnEvent,
    onSettled: args.progress.onSettled,
    replyEntry: (deliveredText) => ({
      id: args.progress.entryId,
      blocks: args.progress.blocksForRecord(deliveredText),
    }),

    divertBeforeTurn: async ({ setPhase }) => {
      if (args.window.mode !== 'agent') return null;
      setPhase('agent-turn');
      if (!(await args.window.reserve()))
        return { send: false, reason: 'superseded-before-agent-turn' };
      const { startConversationAgentTurn } = await import(
        '../agent-sessions/conversation-agent.js'
      );
      const started = await startConversationAgentTurn({
        venue: args.window.venue,
        conversationId: args.window.conversationId,
        windowId: args.window.windowId,
        deliveryKey: args.window.deliveryKey,
        project: { id: args.project.id, slug: args.project.slug, repoPath: args.project.repoPath },
        handleName: args.handleName,
        question: args.window.question,
        askedByLabel: args.askedBy,
        conversationContext: await args.window.conversationContext(),
        ...(args.window.images.length ? { images: args.window.images } : {}),
        persona: webAgentConversationPersona(args.project.name, args.project.slug, args.askedBy),
        door: 'web-agent-completion',
        replies: WEB_AGENT_REPLIES,
        ackAfterMs: null,
      });
      if (started.started) return { send: false, reason: 'agent-turn-dispatched' };
      if (started.reason === 'deduped')
        return {
          send: true,
          message: codeAuthored(WEB_AGENT_REPLIES.dedup),
          screenReplaced: false,
        };
      if (started.reason === 'no-device')
        return {
          send: true,
          message: codeAuthored(WEB_AGENT_REPLIES.noDevice),
          screenReplaced: false,
        };
      if (started.reason === 'attachment-unreadable')
        return {
          send: true,
          message: codeAuthored(
            `I could not send ${started.file ?? 'the file you attached'} to the box that answers in Agent mode, so I have not answered rather than answering without it. Attach it again, or ask in Assistant mode, where I read it here.`,
          ),
          screenReplaced: false,
        };
      return { send: false, reason: 'agent-turn-dispatch-failed' };
    },

    prepare: async ({ principalUserId, speakerUserId, conversationId, handleUserId }) => ({
      persona: webConversationPersona(args.project.name, args.project.slug, args.askedBy),
      resolveImage: makeConversationImageResolver(conversationId),
      tools: buildProjectToolset(
        buildChatToolContext({
          userId: principalUserId,
          projectId: args.project.id,
          projectSlug: args.project.slug,
          turn: { conversationId, speakerUserId, handleUserId },
        }),
      ),
    }),
  };
}

/**
 * What the thread is shown when an Agent turn has no answer to give it.
 */
export const WEB_AGENT_REPLIES = {
  dedup:
    'This conversation already has an Agent turn running. Wait for it to answer, or open another conversation to ask something else in parallel.',
  noDevice:
    'No paired device is free to take this turn right now. Try again in a few minutes, or open a new conversation in Assistant mode for anything that does not need the repository.',
  failed:
    'The Agent session ended without an answer. Ask again — a new turn starts a fresh session — or open a conversation in Assistant mode if the question does not need the repository.',
  ack: null,
} as const;

export interface WebSendResult {
  conversationId: string;
  windowId: string;
  /** The sequence number the person's own message took. */
  seq: number;
  /** What the window decided, where this call routed it. */
  decision: string | null;
  /** What this room answers in, as this send left it. */
  mode: ConversationMode;
}

/**
 * The first send lost the race to settle this room's mode.
 */
export class ConversationModeSettledError extends Error {
  readonly code = 'CONVERSATION_MODE_SETTLED' as const;
  constructor(readonly settled: ConversationMode) {
    super(
      `this conversation already answers in ${settled} mode; a room's mode is written by its first message and never changes, so open another conversation to talk to the other one`,
    );
    this.name = 'ConversationModeSettledError';
  }
}

/**
 * Take one typed message and answer it.
 */
export async function sendWebConversationMessage(args: {
  room: WebConversationRoom;
  projectId: string;
  userId: string;
  userLabel: string | null;
  content: string;
  /** What this send asks the room to answer in — honoured on the FIRST message and nowhere else. */
  mode: ConversationMode;
  /**
   * Whether the caller named a mode at all, as opposed to the route deriving one.
   */
  namedMode: boolean;
  /** The sender's own id for this message, echoed on the accepted event (ISS-1078). */
  clientToken?: string | undefined;
  /** The files staged with this message, as references the turn re-reads (ISS-1146). */
  images?: readonly ConversationImage[] | undefined;
}): Promise<WebSendResult> {
  const frame: WebConversationFrame = {
    conversation: args.room,
    projectId: args.projectId,
    userId: args.userId,
  };
  const collected = await collectInboundMessage({
    ports: webConversationPorts,
    frame,
    message: args.content,
    speakerKey: args.userId,
    speakerLabel: args.userLabel,
    manySpeakersPrincipalUserId: args.userId,
    ...(args.images && args.images.length > 0 ? { images: args.images } : {}),
    withinCollection: async (tx, { conversationId, seq }) => {
      if (seq === 0 && (await settleConversationMode(tx, conversationId, args.mode))) return;
      if (seq !== 0 && !args.namedMode) return;
      const row = await getConversation(conversationId, tx);
      throw new ConversationModeSettledError(effectiveConversationMode(row ?? { mode: null }));
    },
  });
  if (collected.kind !== 'collected') {
    throw new Error(
      `web conversations: conversation ${args.room.id} could not be placed as a venue, so the message was not taken in`,
    );
  }

  await publishToConversationReaders(collected.conversationId, {
    event: WEB_CONVERSATION_ACCEPTED_EVENT,
    data: {
      conversationId: collected.conversationId,
      messageId: collected.messageId,
      seq: collected.seq,
      clientToken: args.clientToken ?? null,
    },
  }).catch((err: unknown) =>
    logger.warn(
      { err, conversationId: collected.conversationId },
      'web conversations: the accepted event was not published',
    ),
  );

  const decision = await routeOneWebWindow(args.room.externalId, `send:${args.userId}`);
  return {
    conversationId: collected.conversationId,
    windowId: collected.windowId,
    seq: collected.seq,
    decision,
    mode: effectiveConversationMode(
      (await getConversation(collected.conversationId)) ?? { mode: null },
    ),
  };
}

/**
 * Everything routing one web window needs, read once: the project it is about
 * and the handle that answers in it.
 */
async function webWindowSubject(
  window: ConversationWindowRow,
  claim: WindowClaim,
): Promise<{
  project: { id: string; slug: string; name: string; repoPath: string | null };
  handle: ProjectHandle;
} | null> {
  const [project] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      repoPath: projects.repoPath,
    })
    .from(projects)
    .where(eq(projects.id, window.projectId))
    .limit(1);
  if (!project) {
    await releaseWindow(window.id, claim);
    return null;
  }
  return { project, handle: await resolveProjectHandle(db, project.id) };
}

/**
 * How many earlier messages a diverted turn is handed.
 */
const AGENT_CONTEXT_MESSAGES = 20;

async function agentConversationContext(window: ConversationWindowRow): Promise<string | null> {
  const before = (await readMessages(window.conversationId, AGENT_CONTEXT_MESSAGES + 1)).filter(
    (m) => m.seq < window.firstSeq,
  );
  if (before.length === 0) return null;
  return before
    .slice(-AGENT_CONTEXT_MESSAGES)
    .map((m) => `${m.authorLabel ?? (m.role === 'assistant' ? 'Assistant' : m.role)}: ${m.content}`)
    .join('\n');
}

export async function routeWebWindow(
  window: ConversationWindowRow,
  claim: WindowClaim,
): Promise<string | null> {
  const subject = await webWindowSubject(window, claim);
  if (!subject) return null;

  const progress = startConversationProgress({
    conversationId: window.conversationId,
    entryId: randomUUID(),
  });

  const stop = registerTurnStop(window.conversationId);
  let outcome: Awaited<ReturnType<typeof routeWindow>>;
  try {
    outcome = await routeWindow({
      window,
      manySpeakersPrincipalUserId: subject.handle.userId,
      handoffFor: async (windowId) =>
        (await import('../agent-sessions/conversation-agent.js')).conversationAgentTurnForWindow(
          windowId,
        ),
      inputs: ({ venue, conversationId, windowId, deliveryKey, mode, messages, reserve }) =>
        webConversationTurn({
          project: subject.project,
          handleName: subject.handle.handle,
          askedBy: messages.filter((m) => m.role === 'user').at(-1)?.authorLabel ?? null,
          window: {
            venue,
            conversationId,
            windowId,
            deliveryKey,
            mode,
            question: messages.map((m) => m.content).join('\n'),
            images: messages.flatMap((m) => m.images ?? []),
            conversationContext: () => agentConversationContext(window),
            reserve,
          },
          progress,
          externalStop: stop.signal,
        }),
    });
  } finally {
    stop.release();
  }
  await progress.close();

  await publishToConversationReaders(window.conversationId, {
    event: WEB_CONVERSATION_SETTLED_EVENT,
    data: {
      conversationId: window.conversationId,
      windowId: window.id,
      decision: outcome.decision,
    },
  }).catch((err: unknown) =>
    logger.warn(
      { err, windowId: window.id },
      'web conversations: the settled event was not published',
    ),
  );
  logger.info(
    { windowId: window.id, projectId: window.projectId, ...outcome },
    'web conversations: window routed',
  );
  return outcome.decision;
}

/**
 * Claim and route whatever this venue owes, and say what was decided.
 */
async function routeOneWebWindow(
  venueExternalId: string,
  claimant: string,
): Promise<string | null> {
  const [window] = await claimDueWindows({
    adapter: 'web',
    claimant,
    limit: 1,
    venuePrefixes: [venueExternalId],
    settleMs: 0,
  });
  if (!window) return null;
  const claim = claimOf(window);
  if (!claim)
    throw new Error(
      'web conversations: a window is routed under its claim, and this one holds none',
    );
  return routeWebWindow(window, claim);
}
