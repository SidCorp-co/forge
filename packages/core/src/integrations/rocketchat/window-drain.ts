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
const DRAIN_INTERVAL_MS = 1500;

/**
 * How many windows one connection takes per tick.
 */
export const WINDOW_DRAIN_BATCH = 5;

/**
 * Start the drain. Returns the stop.
 */
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
  const claim = claimOf(window);
  if (!claim)
    throw new Error('rocketchat: a window is routed under its claim, and this one holds none');
  const parts = parseRocketChatVenueId(window.venueExternalId);
  const route = ac && parts ? ac.routes.get(parts.rid) : undefined;
  if (!ac || !route || !parts || route.projectId !== window.projectId) {
    await releaseWindow(window.id, claim);
    return;
  }
  const outcome = await routeWindow({
    window,
    manySpeakersPrincipalUserId: route.principalUserId,
    handoffFor: async (windowId) =>
      (await import('../../agent-sessions/conversation-agent.js')).conversationAgentTurnForWindow(
        windowId,
      ),
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
    inputs: ({ venue, conversationId, windowId, deliveryKey, messages, reserve, cut }) => {
      const spoken = messages.filter((m) => m.role === 'user');
      return rocketChatTurn({
        cut,
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
