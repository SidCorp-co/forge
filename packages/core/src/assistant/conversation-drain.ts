import { claimDueWindows, claimOf, registerConversationTransport } from '../conversations/index.js';
import { logger } from '../observability/logger.js';
import { webConversationPorts } from './conversation-adapter.js';
import { routeWebWindow } from './conversation-send.js';

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
 * Make the Forge UI an adapter the store can reach. Its recovery drain is a process timer
 * (`timer-registry.ts`).
 */
export function registerWebConversationAdapter(): void {
  registerConversationTransport(webConversationPorts);
}
