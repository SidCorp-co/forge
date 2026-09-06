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
import { revokeSessionToken } from './session-token.js';

// cm:guard everything a session's terminal write owes, for the ONE terminal writer `applyKernelTransition` cannot see. This PATCH is the runner's happy-path completion and a direct `db.update`, so each side-effect hung on the kernel chokepoint needs its twin here or it goes silent for the commonest case in production — the ISS-675 escalation bridge is why this exists, and the ISS-927 token revoke is why it is a function.
// cm:edge lockstep -> packages/core/src/lifecycle/transition.ts — the chokepoint's `entity === 'session'` branch is the other half of every line below. Adding one here without adding it there loses cancel, the sweeper and dispatch failure; adding it there alone loses the happy path.
export async function onTerminalPatch(
  id: string,
  updated: typeof agentSessions.$inferSelect,
): Promise<void> {
  // cm:guard AWAITED, unlike the bridges below, and the asymmetry is the point: a room reply that fails is a missing message, while a revoke that fails is a live write-scoped credential outliving the session it was minted for. Best-effort is the right posture for the first and not for the second.
  await revokeSessionToken(id);

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
