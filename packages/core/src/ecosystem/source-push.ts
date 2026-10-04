import { consume } from '../outbox/index.js';
import { openPushedRuns } from './builder-trigger.js';

/**
 * The ecosystem's reaction to a push a source host reported: a push to the default branch opens the
 * builder runs, the same for every host, so a GitHub push and a GitLab push cannot drift apart.
 */
export function registerSourcePushReactions(): void {
  consume('source.pushed', {
    name: 'ecosystem-builder',
    handle: async (p) => {
      if (p.branch === null) return;
      await openPushedRuns({
        projectId: p.projectId,
        branch: p.branch,
        defaultBranch: p.defaultBranch,
        commit: p.commit ?? undefined,
      });
    },
  });
}
