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

import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { env } from '../../config/env.js';
import { routeWindow } from '../../conversations/route-window.js';
import { type ClaimedWindow, claimDueWindows, releaseWindow } from '../../conversations/windows.js';
import { logger } from '../../logger.js';
import type { ActiveConnection } from './connection-manager.js';
import { parseRocketChatVenueId } from './conversation-port.js';
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
      await routeOne(ac, connectionId, window, webBaseUrl).catch((err) =>
        logger.error({ err, connectionId, windowId: window.id }, 'rocketchat: routing failed'),
      );
    }
  }
}

export async function routeOne(
  ac: ActiveConnection,
  connectionId: string,
  window: ClaimedWindow,
  webBaseUrl: string | undefined,
): Promise<void> {
  const parts = parseRocketChatVenueId(window.venueExternalId);
  const route = parts ? ac.routes.get(parts.rid) : undefined;
  // cm:guard a window this connection can no longer place is RELEASED rather than closed: a binding can change between the claim and the route, the room may be bound on another core, and closing it here would record a decision nobody took and leave the person unanswered for good. A release puts it back where the next tick — here or elsewhere — finds it (ISS-1004 rule 4).
  if (!route || !parts || route.projectId !== window.projectId) {
    await releaseWindow(window.id);
    return;
  }
  const outcome = await routeWindow({
    window,
    manySpeakersPrincipalUserId: route.principalUserId,
    inputs: ({ venue, messages }) => {
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
          text: spoken.map((m) => m.content).join('\n'),
          username: spoken[spoken.length - 1]?.authorLabel ?? undefined,
          messageIds: spoken.flatMap((m) => (m.externalId ? [m.externalId] : [])),
          images: spoken.flatMap((m) => m.images),
        },
        connectionId,
        shape: venue.shape,
        webBaseUrl,
      });
    },
  });
  logger.info(
    { connectionId, windowId: window.id, projectId: window.projectId, ...outcome },
    'rocketchat: window routed',
  );
}
