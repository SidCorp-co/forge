import { provideTerminalSessionBridge } from '../../agent-sessions/index.js';
import { rocketChatManager } from '../../integrations/rocketchat/index.js';
import { logger } from '../../lib/logger.js';
import { registerRoomTurnLive } from '../conversation-adapter.js';
import { drainQuestionDeliveries } from './question-delivery.js';

// Process timers (`timer-registry.ts`): each does nothing until this process's room connections
// have started, and stops with them.

export async function drainRoomQuestions(): Promise<void> {
  if (!rocketChatManager.isStarted()) return;
  const r = await drainQuestionDeliveries();
  if (r.owed > 0) logger.info({ ...r }, 'rocketchat: question delivery drain');
}

/**
 * Hands the session kernel the room replies it owes when a session ends, and the room's view of a
 * turn in flight. Called once at boot.
 */
export function registerRoomBridges(): void {
  registerRoomTurnLive();
  provideTerminalSessionBridge('escalation', async (row) =>
    (await import('./escalation-bridge.js')).deliverEscalationReplyOnce(row),
  );
}
