// A project's next release, as the workspace's Activity row shows it (ISS-951): the soonest
// requirement still landing by its forecast (`forecast/scope.ts:readComingNext`), or the draft
// release where it carries anything. The forecast reads every requirement's scope and moves, so it is
// kept off the page's path (`glance-cache.ts`) and read again behind it once a minute old.

import type { OrgActivityRelease } from '@forge/contracts/org-activity';
import { readComingNext } from '../forecast/index.js';
import { glanceCache } from './glance-cache.js';

async function readNextRelease(projectId: string): Promise<OrgActivityRelease | null> {
  const coming = await readComingNext(projectId, null);
  const scope = coming.requirements[0] ?? (coming.draft.progress.total > 0 ? coming.draft : null);
  if (!scope) return null;
  return {
    key: scope.key,
    title: scope.title,
    shipped: scope.progress.shipped,
    awaitingRelease: scope.progress.awaitingRelease,
    total: scope.progress.total,
  };
}

export const releaseGlances = glanceCache('the next release', 60_000, readNextRelease);
