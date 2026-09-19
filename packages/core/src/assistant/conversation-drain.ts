import { startConversationHeartbeat } from '../conversations/heartbeat.js';
import { registerConversationTransport } from '../conversations/ports.js';
import { claimDueWindows, claimOf } from '../conversations/windows.js';
import { logger } from '../logger.js';
import { webConversationPorts } from './conversation-adapter.js';
import { routeWebWindow } from './conversation-send.js';

/**
 * How often a core looks for web windows nobody finished.
 */
const WEB_DRAIN_INTERVAL_MS = 15_000;

/** How many stranded windows one tick takes. */
const WEB_DRAIN_BATCH = 5;

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
