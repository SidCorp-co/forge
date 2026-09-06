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

export { revokeSessionToken } from './session-token.js';

// cm:guard the ROOM half of what a session's terminal write owes, for the ONE terminal writer `applyKernelTransition` cannot see. The credential half is `revokeSessionToken`, called separately by the same handler because the two want different gates: these bridges fire on the REPORTED status like their siblings, while the revoke fires on the PERSISTED one — a bridge that fires early sends a duplicate room reply, a revoke that fires early kills a running session's token. This PATCH is the runner's happy-path completion and a direct `db.update`, so each side-effect hung on the kernel chokepoint needs its twin here or it goes silent for the commonest case in production — the ISS-675 escalation bridge is why this exists, and the ISS-927 token revoke is why it is a function.
// cm:edge lockstep -> packages/core/src/lifecycle/transition.ts — the chokepoint's `entity === 'session'` branch is the other half of every line below. Adding one here without adding it there loses cancel, the sweeper and dispatch failure; adding it there alone loses the happy path.
export async function onTerminalPatch(updated: typeof agentSessions.$inferSelect): Promise<void> {
  const meta = updated.metadata as { escalation?: unknown; agentChat?: unknown } | null;
  // cm:why the two bridges are best-effort and swallow: the runner's PATCH is its only way to report the turn, and failing it over a RocketChat problem would lose the transcript to save a room message.
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
