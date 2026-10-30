// Fast delivery's production hold (REQ-79 BC-5, BC-6): a change rated high impact reaches production
// only once a green cleanup run covers it, and every lower-rated change goes without waiting. Which
// changes wait is the cleanup module's reading (`cleanup/index.ts:cleanupWaiting`); this module says it
// where a release is refused or a waiting row is held, as `shipped-in.ts` does for its own reason.

import { cleanupWaiting } from '../cleanup/index.js';
import { issueDisplayIds } from '../issues/index.js';
import { blocker } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';
import type { ReleaseHold } from './hold.js';

/** The refusal of a release that would carry a change still waiting for its green cleanup. */
export async function cleanupBlocker(
  projectId: string,
  issueIds: readonly string[],
): Promise<ReleaseBlocker | null> {
  const held = await cleanupWaiting(projectId, issueIds);
  if (held.size === 0) return null;
  const ids = [...held.keys()];
  const shown = await issueDisplayIds(ids);
  return blocker('RELEASE_CLEANUP_PENDING', {
    issueIds: ids,
    displayIds: ids.map((id) => shown.get(id) ?? id),
  });
}

/** The hold a waiting row stands under until a green cleanup covers it: the cleanup run's act. */
export function cleanupHold(rated: { reason: string; type: string }): ReleaseHold {
  return {
    code: 'RELEASE_CLEANUP_PENDING',
    reason:
      `Its building agent rated this change high impact (${rated.type}: ${rated.reason}), and this ` +
      'project delivers fast (REQ-79): a change rated high reaches production only once a green ' +
      "cleanup run covers it, while every lower-rated change goes now. The project's cleanup window " +
      'runs it; its report covers this issue once the green head carries its merge ' +
      '(POST /api/projects/:id/cleanup-reports with `covers`).',
    owes: 'agent',
    waitingFor: "a green cleanup report covering this issue, from the project's cleanup run",
  };
}
