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
import {
  type ConversationImage,
  type ConversationWindowRow,
  claimDueWindows,
  claimOf,
  collectInboundMessage,
  effectiveConversationMode,
  getConversation,
  type ProjectHandle,
  refuseConversation,
  releaseWindow,
  resolveProjectHandle,
  settleConversationMode,
  type WindowClaim,
} from '../conversations/index.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import type { ConversationMode, ConversationShape } from '../db/schema-conversations.js';
import { logger } from '../lib/logger.js';
import {
  publishToConversationReaders,
  WEB_CONVERSATION_ACCEPTED_EVENT,
  WEB_CONVERSATION_SETTLED_EVENT,
  type WebConversationFrame,
  webConversationPorts,
} from './conversation-adapter.js';
import { ConversationProgress } from './conversation-progress.js';
import { registerTurnStop } from './conversation-stops.js';
import { routeWindow } from './route-window.js';
import { agentConversationContext, webConversationTurn } from './web-turn-inputs.js';

/** The room a send happens in, as the route already read it. */
export interface WebConversationRoom {
  id: string;
  externalId: string;
  shape: ConversationShape;
}

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
 * Take one typed message and answer it.
 */
export async function sendWebConversationMessage(args: {
  room: WebConversationRoom;
  projectId: string;
  userId: string;
  /** The access token the sender reached this route with, or null for a browser session (ISS-17). */
  viaTokenId: string | null;
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
    speakerTokenId: args.viaTokenId,
    ...(args.images && args.images.length > 0 ? { images: args.images } : {}),
    withinCollection: async (tx, { conversationId, seq }) => {
      if (seq === 0 && (await settleConversationMode(tx, conversationId, args.mode))) return;
      if (seq !== 0 && !args.namedMode) return;
      const row = await getConversation(conversationId, tx);
      throw refuseConversation(
        'CONVERSATION_MODE_SETTLED',
        `conversation ${conversationId} was opened in ${effectiveConversationMode(row ?? { mode: null })} mode by a message that landed first; this one was not taken in — send it again, or open another conversation to talk to the other mode`,
      );
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
  project: { id: string; slug: string; name: string };
  handle: ProjectHandle;
} | null> {
  const [project] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
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

export async function routeWebWindow(
  window: ConversationWindowRow,
  claim: WindowClaim,
): Promise<string | null> {
  const subject = await webWindowSubject(window, claim);
  if (!subject) return null;

  const progress = new ConversationProgress(window.conversationId, randomUUID());

  const stop = registerTurnStop(window.conversationId);
  let outcome: Awaited<ReturnType<typeof routeWindow>>;
  try {
    outcome = await routeWindow({
      window,
      handoffFor: async (windowId) =>
        (await import('../conversations/index.js')).conversationAgentTurnForWindow(windowId),
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
