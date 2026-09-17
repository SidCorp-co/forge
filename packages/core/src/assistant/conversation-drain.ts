/**
 * What a restart is owed: the web windows a stopped core left behind.
 *
 * A send routes its own window inline, because the person who pressed enter is
 * waiting on the answer. This is the other path — claimed by ADAPTER and on the
 * ordinary settle, so it reaches only what a crash, a rollback or a lost socket
 * stranded. It calls `conversation-send.ts`'s own `routeWebWindow`, so a
 * recovered window is answered by exactly the code an inline one is.
 *
 * It lives beside that module rather than inside it because that file reached its
 * 500-line budget; what came out is the half no request is waiting on (ISS-1078).
 */

import { startConversationHeartbeat } from '../conversations/heartbeat.js';
import { registerConversationTransport } from '../conversations/ports.js';
import { claimDueWindows, claimOf } from '../conversations/windows.js';
import { logger } from '../logger.js';
import { webConversationPorts } from './conversation-adapter.js';
import { routeWebWindow } from './conversation-send.js';

/**
 * How often a core looks for web windows nobody finished.
 */
// cm:guard this loop is the RECOVERY path and never the ordinary one: a send routes its own window inline, because a person who pressed enter is waiting on the answer and a settle delay they did not ask for is latency with nothing bought by it. What this reaches is only what a crash, a rollback or a lost socket left behind (ISS-1004 rule 1).
const WEB_DRAIN_INTERVAL_MS = 15_000;

/** How many stranded windows one tick takes. */
// cm:guard a batch and not everything due, for the reason the first adapter's drain gives: each window costs a model turn, and a core coming back to a hundred of them would spend a hundred turns in one tick.
const WEB_DRAIN_BATCH = 5;

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
