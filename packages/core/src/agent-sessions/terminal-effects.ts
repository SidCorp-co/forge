/**
 * What a session owes when it goes terminal through the runner's own PATCH.
 *
 * Its twin is the `entity === 'session'` branch of `lifecycle/transition.ts`,
 * which covers every other terminal writer — cancel, the stale sweeper, a
 * dispatch failure, a run-close cascade. Neither is sufficient alone, and the
 * split is not a design choice: `PATCH /api/agent-sessions/:id` writes
 * `patch.status`, a variable, so the `lifecycle.transition` guard test cannot
 * see it and never will.
 */

import type { agentSessions } from '../db/schema.js';
import { logger } from '../logger.js';

export async function onTerminalPatch(updated: typeof agentSessions.$inferSelect): Promise<void> {
  const meta = updated.metadata as { escalation?: unknown; agentChat?: unknown } | null;
  if (meta?.escalation) {
    await deliverOnce(
      () => import('../integrations/rocketchat/escalation-bridge.js'),
      (m) => m.deliverEscalationReplyOnce(updated),
      updated.id,
      'escalation',
    );
  }
  if (meta?.agentChat) {
    await deliverOnce(
      () => import('../integrations/rocketchat/agent-chat-bridge.js'),
      (m) => m.deliverAgentChatReplyOnce(updated),
      updated.id,
      'agent-chat',
    );
  }
}

async function deliverOnce<M>(
  load: () => Promise<M>,
  deliver: (mod: M) => Promise<unknown>,
  sessionId: string,
  label: string,
): Promise<void> {
  try {
    await deliver(await load());
  } catch (err) {
    logger.error({ err, sessionId }, `agent-sessions: ${label} bridge failed`);
  }
}
