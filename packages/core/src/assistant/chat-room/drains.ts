import { provideTerminalSessionBridge } from '../../agent-sessions/index.js';
import { rocketChatManager } from '../../integrations/rocketchat/index.js';
import { logger } from '../../observability/logger.js';
import { drainQuestionDeliveries } from './question-delivery.js';

// Process timers (`timer-registry.ts`): each does nothing until this process's room connections
// have started, and stops with them.

export async function drainRoomQuestions(): Promise<void> {
  if (!rocketChatManager.isStarted()) return;
  const r = await drainQuestionDeliveries();
  if (r.owed > 0) logger.info({ ...r }, 'rocketchat: question delivery drain');
}

/** Hands the session kernel the room replies it owes when a session ends. Called once at boot. */
export function registerRoomBridges(): void {
  provideTerminalSessionBridge('escalation', async (row) =>
    (await import('./escalation-bridge.js')).deliverEscalationReplyOnce(row),
  );
}
