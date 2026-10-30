// Fast delivery's promotion hold (REQ-79 BC-5, BC-6): where a person promotes to production, a change
// rated high impact reaches it only once a green cleanup run covers it, and every lower-rated change
// goes without waiting. Which changes wait is the cleanup module's reading
// (`cleanup/index.ts:cleanupWaiting`); this module says it where a release is refused. Where production
// deploys on land nothing waits here: the change is held from landing instead (`issues/merge-check.ts`).

import { cleanupWaiting } from '../cleanup/index.js';
import { issueDisplayIds } from '../issues/index.js';
import { blocker } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';

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
