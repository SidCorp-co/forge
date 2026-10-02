import { openPushedRuns } from '../../ecosystem/builder-trigger.js';
import { observeLand } from '../../ecosystem/contract/land.js';
import { forgetLiveReading } from '../../projects/live-reading.js';

/**
 * What every host's push delivery does before anything host-specific: the live reading is stale, a
 * land on a deployed branch is measured, and a push to the default branch opens the ecosystem
 * builder runs. One function, so a GitHub push and a GitLab push cannot drift apart.
 */
export async function applyPushedBranch(input: {
  projectId: string;
  bindingId: string;
  branch: string;
  commit: string | undefined;
  defaultBranch: string | null;
}): Promise<number> {
  forgetLiveReading(input.projectId);
  const lands = await observeLand({
    projectId: input.projectId,
    bindingId: input.bindingId,
    branch: input.branch,
    commit: input.commit,
  });
  await openPushedRuns({
    projectId: input.projectId,
    branch: input.branch,
    defaultBranch: input.defaultBranch,
    commit: input.commit,
  });
  return lands;
}
