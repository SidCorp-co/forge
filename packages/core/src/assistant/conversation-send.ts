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
  earlierUnderKey,
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
import { agentConversationContext } from './web-agent-diversion.js';
import { webConversationTurn } from './web-turn-inputs.js';

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

/** What a send asks of the room, whichever door it came through. */
export interface WebSendArgs {
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
  /**
   * The sender's own key for this message, kept as its transport id, under which a retried send is
   * taken in once (REQ-91 BC-6): a second send under a key this room already holds is not written,
   * and the message the first one wrote is answered instead.
   */
  externalMessageId?: string | undefined;
}

/** A message taken in, or the one an earlier send under the same key wrote. */
export type WebAccepted =
  | { kind: 'accepted'; conversationId: string; windowId: string; messageId: string; seq: number }
  | { kind: 'duplicate'; conversationId: string; messageId: string; seq: number; content: string };

/** Thrown inside the collection to roll it back when the key is already held. */
class HeldKey {
  constructor(readonly earlier: { id: string; seq: number; content: string }) {}
}

/**
 * Take one typed message into its room and its window, under one commit, and tell the room's readers.
 * Nothing is answered here: `routeOneWebWindow` does that, now or once the caller lets it run.
 */
export async function acceptWebConversationMessage(args: WebSendArgs): Promise<WebAccepted> {
  const frame: WebConversationFrame = {
    conversation: args.room,
    projectId: args.projectId,
    userId: args.userId,
  };
  const key = args.externalMessageId;
  let collected: Awaited<ReturnType<typeof collectInboundMessage>>;
  try {
    collected = await collectInboundMessage({
      ports: webConversationPorts,
      frame,
      message: args.content,
      speakerKey: args.userId,
      speakerLabel: args.userLabel,
      speakerTokenId: args.viaTokenId,
      ...(key ? { externalMessageId: key } : {}),
      ...(args.images && args.images.length > 0 ? { images: args.images } : {}),
      withinCollection: async (tx, { conversationId, seq }) => {
        // the room row is held FOR UPDATE by the append, so a concurrent retry under the same key
        // reads this one's row once it commits, and is rolled back here
        if (key) {
          const earlier = await earlierUnderKey(tx, conversationId, key, seq);
          if (earlier) throw new HeldKey(earlier);
        }
        if (seq === 0 && (await settleConversationMode(tx, conversationId, args.mode))) return;
        if (seq !== 0 && !args.namedMode) return;
        const row = await getConversation(conversationId, tx);
        throw refuseConversation(
          'CONVERSATION_MODE_SETTLED',
          `conversation ${conversationId} was opened in ${effectiveConversationMode(row ?? { mode: null })} mode by a message that landed first; this one was not taken in — send it again, or open another conversation to talk to the other mode`,
        );
      },
    });
  } catch (err) {
    if (!(err instanceof HeldKey)) throw err;
    return {
      kind: 'duplicate',
      conversationId: args.room.id,
      messageId: err.earlier.id,
      seq: err.earlier.seq,
      content: err.earlier.content,
    };
  }
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
  return {
    kind: 'accepted',
    conversationId: collected.conversationId,
    windowId: collected.windowId,
    messageId: collected.messageId,
    seq: collected.seq,
  };
}

/**
 * Take one typed message and answer it.
 */
export async function sendWebConversationMessage(args: WebSendArgs): Promise<WebSendResult> {
  const accepted = await acceptWebConversationMessage(args);
  if (accepted.kind !== 'accepted') {
    throw new Error(
      `web conversations: a send to conversation ${args.room.id} named no key, and was answered as a duplicate`,
    );
  }
  const decision = await routeOneWebWindow(args.room.externalId, `send:${args.userId}`);
  return {
    conversationId: accepted.conversationId,
    windowId: accepted.windowId,
    seq: accepted.seq,
    decision,
    mode: effectiveConversationMode(
      (await getConversation(accepted.conversationId)) ?? { mode: null },
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
  progress.begin();

  const stop = registerTurnStop(window.conversationId);
  let outcome: Awaited<ReturnType<typeof routeWindow>>;
  try {
    outcome = await routeWindow({
      window,
      handoffFor: async (windowId) =>
        (await import('../conversations/index.js')).conversationAgentTurnForWindow(windowId),
      inputs: ({
        venue,
        conversationId,
        windowId,
        deliveryKey,
        mode,
        messages,
        reserve,
        authority,
      }) => {
        // the person this turn acts as is the one reader shown its draft and its tool calls
        progress.askedBy(authority.userId);
        return webConversationTurn({
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
            latest: messages.filter((m) => m.role === 'user').at(-1)?.content ?? '',
            images: messages.flatMap((m) => m.images ?? []),
            conversationContext: () => agentConversationContext(window),
            reserve,
          },
          progress,
          externalStop: stop.signal,
        });
      },
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
      ...(continuingOf(outcome.detail) ? { continuing: true } : {}),
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

/** Whether the window closed on a partial reply whose turn is still working in the thread. */
function continuingOf(detail: unknown): boolean {
  return (
    typeof detail === 'object' &&
    detail !== null &&
    (detail as { continuing?: unknown }).continuing === true
  );
}

/**
 * Claim and route whatever this venue owes, and say what was decided.
 */
export async function routeOneWebWindow(
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
