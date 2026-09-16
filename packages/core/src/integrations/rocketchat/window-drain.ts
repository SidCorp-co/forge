/**
 * Settling collector windows for this transport, and the tick that does it.
 *
 * The collector puts a message in its window and stops. Something has to come
 * back for the window once it has been quiet long enough: this claims what each
 * live connection's own rooms owe, and hands each one to the neutral router with
 * this transport's turn inputs.
 *
 * It lives in the ADAPTER and not in a neutral sweeper because routing a window
 * needs those inputs — the persona, the toolset, the seed context. Registering a
 * router on `ConversationTransport` would have made a second adapter five
 * functions instead of four, which is the property ISS-1002 exists to keep
 * (ISS-1004).
 */

import { conversationAgentTurnForWindow } from '../../agent-sessions/conversation-agent.js';
import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { env } from '../../config/env.js';
import { routeWindow, type WindowMessage } from '../../conversations/route-window.js';
import {
  type ClaimedWindow,
  claimDueWindows,
  claimOf,
  releaseWindow,
} from '../../conversations/windows.js';
import { logger } from '../../logger.js';
import type { ActiveConnection } from './connection-manager.js';
import { parseRocketChatVenueId, rocketChatConversationPorts } from './conversation-port.js';
import { rocketChatTurn } from './turn-inputs.js';

/**
 * How often the drain looks.
 */
// cm:guard well UNDER `WINDOW_SETTLE_MS`, so the latency a person feels is the settle delay they were promised and not the settle delay plus a tick: at an interval above it, two messages typed together could still be answered a whole tick after the second one stopped extending the window.
const DRAIN_INTERVAL_MS = 1500;

/**
 * How many windows one connection takes per tick.
 */
// cm:guard a BATCH and not everything due, because each window costs a model turn: a core coming back to a hundred windows left by a restart would take a hundred turns in one tick and exhaust the single provider login the box holds. The remainder is still due on the next tick and nothing is lost (ISS-1004).
export const WINDOW_DRAIN_BATCH = 5;

/**
 * Start the drain. Returns the stop.
 */
// cm:guard a tick that is still running is never overlapped by the next one: two drains at once would each claim a batch, and the second one's windows would sit under a live lease while the first was still paying for its turns.
export function startWindowDrainLoop(alive: () => boolean, drain: () => Promise<void>): () => void {
  let running = false;
  const tick = (): void => {
    if (!alive() || running) return;
    running = true;
    void drain()
      .catch((err) => logger.error({ err }, 'rocketchat: the window drain tick failed'))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, DRAIN_INTERVAL_MS);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}

/**
 * Settle and route every window this core's connections owe an answer.
 */
// cm:guard each connection drains only the rooms IT binds, and that is what makes the claim safe across cores: a core that claimed a window for a room another core's socket owns would hold it for a whole lease while nobody could deliver through it. The prefix is this transport's own venue-id shape and the collector treats it as opaque (ISS-1004).
// cm:guard a claim is taken per TICK and never held across one: the lease is what recovers a core that stops mid-route, and a loop that re-claimed what it already holds would keep resetting that lease from a process that had already died.
export async function drainConversationWindows(
  conns: ReadonlyMap<string, ActiveConnection>,
  webBaseUrl: string | undefined,
): Promise<void> {
  for (const [connectionId, ac] of conns) {
    if (ac.closing || !ac.client) continue;
    const namespace = namespaceFromServerUrl(ac.serverUrl);
    if (!namespace) continue;
    const venuePrefixes = [...ac.routes.keys()].map((rid) => `${namespace} ${rid}`);
    if (venuePrefixes.length === 0) continue;
    const windows = await claimDueWindows({
      adapter: 'rocketchat',
      claimant: `${env.NODE_ENV}:${connectionId}`,
      limit: WINDOW_DRAIN_BATCH,
      venuePrefixes,
    }).catch((err) => {
      logger.error({ err, connectionId }, 'rocketchat: claiming windows failed');
      return [] as ClaimedWindow[];
    });
    for (const window of windows) {
      // cm:guard the connection is re-read from the live map between the claim and EACH route, not trusted from the top of the tick: a reload replaces the object and a lock loss marks it closing, and neither clears the old object's route map — so a stale `ac` still places the room and would answer it with the former binding's principal and credentials (ISS-1004, review pass 2 F2).
      await routeOne(
        () => (conns.get(connectionId) === ac && !ac.closing ? ac : null),
        connectionId,
        window,
        webBaseUrl,
      ).catch((err) =>
        logger.error({ err, connectionId, windowId: window.id }, 'rocketchat: routing failed'),
      );
    }
  }
}

export async function routeOne(
  current: () => ActiveConnection | null,
  connectionId: string,
  window: ClaimedWindow,
  webBaseUrl: string | undefined,
): Promise<void> {
  const ac = current();
  // cm:guard a window handed here without a claim is a caller error and not a case to absorb: every write below is fenced on the claim, and there is nothing to fence on without one (ISS-1004).
  const claim = claimOf(window);
  if (!claim)
    throw new Error('rocketchat: a window is routed under its claim, and this one holds none');
  const parts = parseRocketChatVenueId(window.venueExternalId);
  const route = ac && parts ? ac.routes.get(parts.rid) : undefined;
  // cm:guard a window this connection can no longer place is RELEASED rather than closed: a binding can change between the claim and the route, the room may be bound on another core, and closing it here would record a decision nobody took and leave the person unanswered for good. A release puts it back where the next tick — here or elsewhere — finds it (ISS-1004 rule 4).
  if (!ac || !route || !parts || route.projectId !== window.projectId) {
    await releaseWindow(window.id, claim);
    return;
  }
  const outcome = await routeWindow({
    window,
    manySpeakersPrincipalUserId: route.principalUserId,
    // cm:guard a window reclaimed after this core died mid-handoff has a reservation and no delivered row, which `route-window.ts` alone reads as a delivery whose outcome was lost. This says which it was, so the room's record names the session still writing the answer rather than announcing one that was never sent (ISS-1039).
    handoffFor: conversationAgentTurnForWindow,
    // cm:guard the refusal is asked of the SPEAKER PORT rather than written here, with the key the collector kept: it names the exact steps that link that chat account, which is ISS-977's contract, and a copy here would drift the day those endpoints move (ISS-1004).
    refusalFor: async ({ authorKey, authorLabel }) => {
      if (!authorKey) return null;
      const resolved = await rocketChatConversationPorts.resolveSpeaker({
        m: { rid: parts.rid, userId: authorKey, username: authorLabel ?? undefined },
        auth: {
          serverUrl: ac.serverUrl,
          authToken: ac.authToken,
          userId: ac.botUserId,
        },
        projectId: window.projectId,
        shape: 'direct',
      } as never);
      return resolved.linked ? null : resolved.refusal.message;
    },
    inputs: ({ venue, conversationId, windowId, deliveryKey, messages, reserve }) => {
      const spoken = messages.filter((m) => m.role === 'user');
      return rocketChatTurn({
        bot: {
          botName: ac.botName,
          serverUrl: ac.serverUrl,
          authToken: ac.authToken,
          botUserId: ac.botUserId,
        },
        route,
        subject: {
          rid: parts.rid,
          tmid: parts.tmid ?? undefined,
          ...windowSubject(spoken),
          messageIds: spoken.flatMap((m) => (m.externalId ? [m.externalId] : [])),
          images: spoken.flatMap((m) => m.images),
        },
        connectionId,
        shape: venue.shape,
        webBaseUrl,
        beforeDivert: reserve,
        window: { venue, conversationId, windowId, deliveryKey },
      });
    },
  });
  logger.info(
    { connectionId, windowId: window.id, projectId: window.projectId, ...outcome },
    'rocketchat: window routed',
  );
}

/**
 * The window's words, and who to say they came from.
 */
// cm:guard a window with more than one speaker is LABELLED and has no single asker, because both are the same fact: Alice asking "deploy production?" and Bob answering "no, staging" is one body of text whose meaning is in who said which half. Joining it unlabelled under the newest speaker's name attributes Alice's question to Bob, and the collector stored the labels precisely so this would not have to guess (ISS-1004, review pass 2 F5).
function windowSubject(spoken: readonly WindowMessage[]): {
  text: string;
  username: string | undefined;
} {
  const speakers = new Set(spoken.map((m) => m.authorLabel ?? ''));
  if (speakers.size <= 1) {
    return {
      text: spoken.map((m) => m.content).join('\n'),
      username: spoken[spoken.length - 1]?.authorLabel ?? undefined,
    };
  }
  return {
    text: spoken.map((m) => `${m.authorLabel ?? 'someone'}: ${m.content}`).join('\n'),
    username: undefined,
  };
}
