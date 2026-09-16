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
 * The drain loop at the bottom is what a restart is owed: a window opened by a
 * send whose core died is still a question somebody asked, and it is claimed and
 * routed by whichever core comes back.
 */

import { eq } from 'drizzle-orm';
import { collectInboundMessage } from '../conversations/collect-inbound.js';
import { type ProjectHandle, resolveProjectHandle } from '../conversations/handles.js';
import { startConversationHeartbeat } from '../conversations/heartbeat.js';
import { registerConversationTransport } from '../conversations/ports.js';
import { routeWindow, type WindowTurnInputs } from '../conversations/route-window.js';
import {
  type ConversationWindowRow,
  claimDueWindows,
  claimOf,
  releaseWindow,
  type WindowClaim,
} from '../conversations/windows.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import type { ConversationShape } from '../db/schema-conversations.js';
import { logger } from '../logger.js';
import {
  publishToConversationReaders,
  WEB_CONVERSATION_SETTLED_EVENT,
  type WebConversationFrame,
  webConversationPorts,
} from './conversation-adapter.js';
import { webConversationPersona } from './door-persona.js';
import { buildChatToolContext } from './tools/principal.js';
import { buildProjectToolset } from './tools/registry.js';

/** The room a send happens in, as the route already read it. */
export interface WebConversationRoom {
  id: string;
  externalId: string;
  shape: ConversationShape;
}

/**
 * How often a core looks for web windows nobody finished.
 */
const WEB_DRAIN_INTERVAL_MS = 15_000;

/** How many stranded windows one tick takes. */
const WEB_DRAIN_BATCH = 5;

/**
 * What the Forge UI contributes to a turn: who the assistant is, and what it may read.
 */
export function webConversationTurn(args: {
  project: { id: string; slug: string; name: string };
  handleName: string;
  askedBy: string | null;
}): WindowTurnInputs {
  return {
    door: 'web-chat-reply',
    handleName: args.handleName,
    log: { adapter: 'web', projectId: args.project.id },
    prepare: async ({ principalUserId, speakerUserId, conversationId, handleUserId }) => ({
      persona: webConversationPersona(args.project.name, args.project.slug, args.askedBy),
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

export interface WebSendResult {
  conversationId: string;
  windowId: string;
  /** The sequence number the person's own message took. */
  seq: number;
  /** What the window decided, where this call routed it. */
  decision: string | null;
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
  });
  if (collected.kind !== 'collected') {
    throw new Error(
      `web conversations: conversation ${args.room.id} could not be placed as a venue, so the message was not taken in`,
    );
  }

  const decision = await routeOneWebWindow(args.room.externalId, `send:${args.userId}`);
  return {
    conversationId: collected.conversationId,
    windowId: collected.windowId,
    seq: collected.seq,
    decision,
  };
}

/**
 * Everything routing one web window needs, read once: the project it is about
 * and the handle that answers in it.
 */
async function webWindowSubject(
  window: ConversationWindowRow,
  claim: WindowClaim,
): Promise<{ project: { id: string; slug: string; name: string }; handle: ProjectHandle } | null> {
  const [project] = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(eq(projects.id, window.projectId))
    .limit(1);
  if (!project) {
    await releaseWindow(window.id, claim);
    return null;
  }
  return { project, handle: await resolveProjectHandle(db, project.id) };
}

async function routeWebWindow(
  window: ConversationWindowRow,
  claim: WindowClaim,
): Promise<string | null> {
  const subject = await webWindowSubject(window, claim);
  if (!subject) return null;
  const outcome = await routeWindow({
    window,
    manySpeakersPrincipalUserId: subject.handle.userId,
    inputs: ({ messages }) =>
      webConversationTurn({
        project: subject.project,
        handleName: subject.handle.handle,
        askedBy: messages.filter((m) => m.role === 'user').at(-1)?.authorLabel ?? null,
      }),
  });
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

/**
 * Route every web window a stopped core left behind.
 */
export async function drainWebConversationWindows(): Promise<void> {
  const windows = await claimDueWindows({
    adapter: 'web',
    claimant: 'web-drain',
    limit: WEB_DRAIN_BATCH,
  });
  for (const window of windows) {
    const claim = claimOf(window);
    if (!claim) continue;
    await routeWebWindow(window, claim).catch((err) =>
      logger.error(
        { err, windowId: window.id },
        'web conversations: routing a stranded window failed',
      ),
    );
  }
}

/**
 * Make the Forge UI an adapter the store can reach, and start its recovery drain.
 */
export function registerWebConversationAdapter(): () => void {
  registerConversationTransport(webConversationPorts);
  const stopDrain = startWebConversationDrain();
  const stopHeartbeat = startConversationHeartbeat();
  return () => {
    stopDrain();
    stopHeartbeat();
  };
}

/**
 * Start the recovery drain. Returns the stop.
 */
export function startWebConversationDrain(): () => void {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void drainWebConversationWindows()
      .catch((err) => logger.error({ err }, 'web conversations: the drain tick failed'))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, WEB_DRAIN_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
