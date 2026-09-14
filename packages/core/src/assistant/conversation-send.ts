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
// cm:guard this loop is the RECOVERY path and never the ordinary one: a send routes its own window inline, because a person who pressed enter is waiting on the answer and a settle delay they did not ask for is latency with nothing bought by it. What this reaches is only what a crash, a rollback or a lost socket left behind (ISS-1004 rule 1).
const WEB_DRAIN_INTERVAL_MS = 15_000;

/** How many stranded windows one tick takes. */
// cm:guard a batch and not everything due, for the reason the first adapter's drain gives: each window costs a model turn, and a core coming back to a hundred of them would spend a hundred turns in one tick.
const WEB_DRAIN_BATCH = 5;

/**
 * What the Forge UI contributes to a turn: who the assistant is, and what it may read.
 */
// cm:guard the toolset is READ-ONLY and fenced to this project and this caller, which is the same fence `assistant/routes.ts` puts on `/api/chat`: a conversation turn is not an authorization to write, and widening it here widens it for every room this adapter serves.
export function webConversationTurn(args: {
  project: { id: string; slug: string; name: string };
  handleName: string;
  askedBy: string | null;
}): WindowTurnInputs {
  return {
    door: 'chat-sync',
    handleName: args.handleName,
    log: { adapter: 'web', projectId: args.project.id },
    prepare: async ({ principalUserId }) => ({
      persona: webConversationPersona(args.project.name, args.askedBy),
      tools: buildProjectToolset(
        buildChatToolContext({
          userId: principalUserId,
          projectId: args.project.id,
          projectSlug: args.project.slug,
        }),
      ),
    }),
  };
}

/**
 * The assistant's voice in a Forge conversation.
 */
// cm:guard it says what this surface CAN do rather than leaving the reader to find out: the Forge UI chat used to be a Claude Code session on a runner with the repository checked out, and a conversation turn reads the project through read-only tools and no working tree. A persona that did not say so would let the same screen answer a question about a file as though it had looked (ISS-1004 step 5).
export function webConversationPersona(projectName: string, askedBy: string | null): string {
  return [
    `You are the working assistant for project "${projectName}", answering a person in the Forge web app.`,
    ...(askedBy ? [`- You are answering ${askedBy}.`] : []),
    '- You read this project through your tools — its issues, its progress, its knowledge and its memory. You have no checkout of the repository and no shell, so say so plainly when you are asked about a file rather than guessing at its contents.',
    '- Lead with what you FOUND. A question about status is answered with the figures, not with a description of how you would find them.',
    '- Answer in the language the person wrote in.',
  ].join('\n');
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
// cm:guard the window is claimed with a settle of ZERO and scoped to THIS room's venue id, never by adapter alone: the settle exists so two messages typed seconds apart in a chat room become one turn, and a person pressing enter in the Forge UI has already told us the message is finished. Claiming by adapter alone would take other rooms' windows into a request that is about one of them.
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
// cm:guard the handle is RESOLVED rather than named from the slug: `handleNameForProject` composes a name and this returns the row, so the same call gives the fallbacks their voice and gives a group-shaped room a principal to run as. A web room is `direct` today and takes its principal from the speaker, which is why the handle is the honest value for the other branch rather than a placeholder nothing reads.
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
  // cm:guard published AFTER `routeWindow` has recorded the reply and closed the window, which is the whole point of it being a second event: the delivery event goes out before the row commits, so a tab that refetched on that alone could read the room back without the answer in it. Every decision publishes, not only `answered`, because a silence is equally something a second tab is sitting and waiting for (ISS-1004 step 5, review F2).
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
// cm:guard a window this core claimed and cannot place is RELEASED and not closed, the same rule the first adapter's drain follows: the project it was opened under can be gone by the time this runs, and closing it would record a decision nobody took (ISS-1004 rule 4).
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
// cm:guard claimed by ADAPTER here and with the ordinary settle, which is the opposite of the send path above and deliberately so: this tick knows nothing about which room it is serving, and the settle is what keeps it off a window a live request is about to route inline.
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
// cm:guard the registration lives HERE and not in `index.ts`, and the reason is a gate rather than a taste: `index.ts` already coordinates 48 modules against an `.arch.json` limit of 6, frozen at that set by the archmap baseline, so a direct `conversations/ports.js` import there is a 49th module and a new violation of a rule the file is already amnestied for. One call from the module that owns the adapter costs the coordinator nothing it was not already paying (ISS-1004 step 5).
// cm:guard the transport is registered BEFORE the drain starts, never after: a stranded window claimed by a tick that ran first would find no `web` transport in the registry and close `unreachable` a question somebody is still owed.
// cm:guard NOT gated on the `chatProvider` flag — that flag gates the SSE `/api/chat` surface, while `/api/conversations` is mounted unconditionally, so gating this would leave a send endpoint whose reply had nowhere to be delivered.
export function registerWebConversationAdapter(): () => void {
  registerConversationTransport(webConversationPorts);
  return startWebConversationDrain();
}

/**
 * Start the recovery drain. Returns the stop.
 */
// cm:guard a tick still running is never overlapped by the next, which is the first adapter's rule and holds for the same reason: two drains at once each claim a batch, and the loser's windows sit under a live lease while the winner pays for its turns.
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
