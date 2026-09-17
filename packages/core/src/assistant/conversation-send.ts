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
import {
  type ConversationVenue,
  codeAuthored,
  registerConversationTransport,
} from '../conversations/ports.js';
import { routeWindow, type WindowTurnInputs } from '../conversations/route-window.js';
import {
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
import { startConversationProgress } from './conversation-progress.js';
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
// cm:guard the toolset is NOT read-only, and this annotation said it was until ISS-1005 measured it: `CHAT_TOOL_ALLOWLIST` permits `forge_issues` create and update and `forge_comments` create. What fences it is `guardIssueWrites` — a created issue is forced to `draft` so it cannot auto-triage and spawn a run, `data.relations` is refused outright, and an update may only reach draft/waiting/needs_info/on_hold/closed. That fence is per-key and OPEN by default, which is how `data.relations` reached chat unclassified in ISS-868 and let a room retract a live `blocks` edge, so a key added to the allowlist is unfenced until somebody classifies it. It is the same set `/api/chat` builds, and widening it here widens it for every room this adapter serves.
// cm:guard the door is `web-chat-reply` and NOT `chat-sync`: this reply's reader holds a role on the project by the route's own checks, and `chat-sync`'s `public:report` cell is written for a reader who holds none — its `no-developer-detail` rule refuses a file path, a fenced block and a raw status word, which are three of the things a person opens the Forge UI to ask for. The reason lives on the door's row in `messaging/doors.ts` (ISS-1005).
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
    /**
     * What was said in this room BEFORE this window, for a turn answered out of reach.
     */
    // cm:guard a thunk and not a value, because only the `agent` branch spends it: the in-core turn
    // gets the room's history from its own window, and building this eagerly would put an extra read
    // on every Assistant send for a string that branch never looks at.
    conversationContext: () => Promise<string | null>;
    reserve: () => Promise<boolean>;
  };
}): WindowTurnInputs {
  // cm:guard the handle is built HERE, where the window's turn inputs are, and threads down through
  // the spread `route-window.ts` already makes — so the events reach the socket with no second venue
  // opening, no second toolset construction and no second persona. Those three are the costs
  // `docs/proposals/api-chat-has-no-client.md` prices, and a fourth site of them is what this change
  // must not add (ISS-1078).
  const progress = startConversationProgress({ conversationId: args.window.conversationId });
  return {
    door: 'web-chat-reply',
    handleName: args.handleName,
    log: { adapter: 'web', projectId: args.project.id, mode: args.window.mode },
    onTurnEvent: progress.onTurnEvent,
    onSettled: progress.onSettled,

    // cm:guard THE fork, and the only one: `assistant` returns null and the in-core turn below runs
    // exactly as it did, while `agent` hands the whole turn to the runner-hosted lane and answers
    // nothing here. A second send route, a second collector or a second delivery for Agent mode is
    // the two-live-paths defect the conversation store was extracted to end (ISS-1039).
    // cm:guard the reservation is taken BEFORE the dispatch: the reply arrives out of this turn's
    // reach, so a window re-claimed after a crash has to read that stamp and dispatch nothing
    // (ISS-1004 rule 2).
    divertBeforeTurn: async ({ setPhase }) => {
      if (args.window.mode !== 'agent') return null;
      setPhase('agent-turn');
      if (!(await args.window.reserve()))
        return { send: false, reason: 'superseded-before-agent-turn' };
      // cm:guard imported HERE and not at the top of the file, for the reason `door-persona.ts`
      // states about itself: `web-door.test.ts` and `conversation-send.test.ts` compose a persona
      // with `db/client.js` mocked and no environment, and the runner-hosted lane's own import tree
      // reaches `config/env.ts`. A static import would make both files fail to COLLECT rather than
      // fail an assertion — a whole file's coverage gone for a symbol two branches never reach.
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
        // cm:guard the room's own earlier turns go WITH the dispatch, because this lane runs a fresh
        // session per turn and the door above invites a follow-up: a person answering "the second
        // one" reaches a session that never saw the first. The inline turn gets this for free from
        // the window's own messages; a diverted one has to be handed it (commit consult F4).
        conversationContext: await args.window.conversationContext(),
        persona: webAgentConversationPersona(args.project.name, args.project.slug, args.askedBy),
        door: 'web-agent-completion',
        replies: WEB_AGENT_REPLIES,
        // cm:guard no interim ack: the thread already prints `dispatched` and `running` beside the
        // question, so a sentence promising an answer would be the same fact twice, in a room where
        // the second copy would be indistinguishable from the answer itself.
        ackAfterMs: null,
      });
      // cm:guard send NOTHING when the dispatch started: the reply lands through the completion
      // bridge, and a line here would put a promise in front of an answer.
      if (started.started) return { send: false, reason: 'agent-turn-dispatched' };
      if (started.reason === 'deduped')
        return { send: true, message: codeAuthored(WEB_AGENT_REPLIES.dedup) };
      if (started.reason === 'no-device')
        return { send: true, message: codeAuthored(WEB_AGENT_REPLIES.noDevice) };
      // cm:guard 'dispatch-failed' sends nothing either — the session was created and then marked
      // failed, so the completion bridge delivers the one honest sentence; replying here as well
      // would put two failures in the thread for one turn.
      return { send: false, reason: 'agent-turn-dispatch-failed' };
    },

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

/**
 * What the thread is shown when an Agent turn has no answer to give it.
 */
// cm:guard each one names what to do next and not only what went wrong: a person who asked for a box
// and got a bare failure has been told less than nothing, since the one thing they can act on — open
// another conversation, wait for the turn already running — is the half a failure sentence usually
// leaves out (ISS-1039).
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
// cm:guard a class rather than a flag, because the caller's answer to it is a REFUSAL and not a
// branch: two people opening the same empty room at the same moment both pass the route's
// "this room holds no message" read, and exactly one of their picks becomes the room's. The loser
// is told which mode won and its message is never collected — a client that believes it opened an
// Agent room and a room that did not is the defect this whole rule exists to prevent (ISS-1039).
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
// cm:guard the window is claimed with a settle of ZERO and scoped to THIS room's venue id, never by adapter alone: the settle exists so two messages typed seconds apart in a chat room become one turn, and a person pressing enter in the Forge UI has already told us the message is finished. Claiming by adapter alone would take other rooms' windows into a request that is about one of them.
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
  // cm:guard kept APART from `mode`, because the two answer different questions and only this one
  // decides a refusal: the route's "is this room empty" read and the collector's commit are not one
  // act, so a send that named a mode can still arrive second — and a second send that named one is
  // refused whether or not it happens to name the mode that won. A client that believes it chose a
  // lane over a room that had already chosen is the defect the whole rule exists to prevent
  // (ISS-1039, plan consult F2).
  namedMode: boolean;
  /**
   * The caller's own id for the copy of this message it is already showing.
   */
  // cm:guard echoed back on the `accepted` frame and stored nowhere: two tabs may each have a
  // message in flight in one room, and a frame matched on the room alone would clear the other
  // tab's unsent row while its own question was still unanswered (ISS-1078).
  clientToken?: string | undefined;
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
    // cm:guard the mode is settled INSIDE the transaction that commits the message and its window,
    // and it throws rather than returning false: mode-and-no-message and message-and-no-mode are
    // both states a recovery cannot read, and the only way to have neither is for the two to be one
    // commit. The `seq === 0` test is what makes it the FIRST message and not every message
    // (ISS-1039, plan consult F2).
    withinCollection: async (tx, { conversationId, seq }) => {
      if (seq === 0 && (await settleConversationMode(tx, conversationId, args.mode))) return;
      // cm:guard reached two ways and refused the same way in both: this send lost the race to
      // settle, or it landed behind a message that had already settled one. Neither is a send whose
      // mode was honoured, and both are refused naming what the room actually answers in.
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

  // cm:guard published the moment the collector's transaction COMMITTED and before the turn is
  // routed, which is the whole of what this event is for: the message is durable long before the
  // answer exists, and until this frame the only thing that told a browser so was the POST
  // returning — which it does not do until the turn is over. The token is the caller's own, echoed
  // back, so the tab that typed it clears its own outbox row and not another tab's (ISS-1078).
  // cm:guard best-effort, as every push on this transport is: zero open sockets is not a failed
  // send, and the row is in the log whether or not anybody was listening.
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
    // cm:guard read back off the row rather than echoed from the argument: on every send but the
    // first the argument was ignored, and answering with it would tell the caller the room took a
    // mode it did not take.
    mode: effectiveConversationMode(
      (await getConversation(collected.conversationId)) ?? { mode: null },
    ),
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
// cm:guard bounded, and bounded HERE rather than in the prompt builder: the session has the history
// tools for anything deeper, and an unbounded transcript in a prompt is a room's whole life paid for
// on every turn (ISS-609's rule, this lane's version of it).
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

async function routeWebWindow(
  window: ConversationWindowRow,
  claim: WindowClaim,
): Promise<string | null> {
  const subject = await webWindowSubject(window, claim);
  if (!subject) return null;

  const outcome = await routeWindow({
    window,
    manySpeakersPrincipalUserId: subject.handle.userId,
    // cm:guard a window reclaimed after this core died mid-handoff carries a reservation and no
    // delivered row, which `route-window.ts` alone reads as a delivery whose outcome was lost —
    // and the thread prints that reading as "a reply was sent and never confirmed" under a turn
    // still being written on a box (ISS-1039).
    // cm:guard the same lazy reach the divert makes, and for the same reason (see above).
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
          conversationContext: () => agentConversationContext(window),
          reserve,
        },
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
  const stopDrain = startWebConversationDrain();
  // cm:guard the heartbeat starts HERE for the reason the registration itself does — `index.ts` is at its coordinator limit and may not reach one more module — and it is not the web adapter's: the tick opens windows in every adapter's rooms and each adapter's own drain routes them (ISS-1034 criteria 36-38).
  const stopHeartbeat = startConversationHeartbeat();
  return () => {
    stopDrain();
    stopHeartbeat();
  };
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
