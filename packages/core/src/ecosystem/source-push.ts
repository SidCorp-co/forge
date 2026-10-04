import { consume } from '../outbox/index.js';
import { openPushedRuns } from './builder-trigger.js';
import { observeLand } from './contract/land.js';

/**
 * The ecosystem's reactions to a push a source host reported: a land on a deployed branch is
 * measured, and a push to the default branch opens the builder runs. One reaction per effect for
 * every host, so a GitHub push and a GitLab push cannot drift apart and a failed one retries alone.
 */
export function registerSourcePushReactions(): void {
  consume('source.pushed', {
    name: 'ecosystem-land',
    handle: async (p) => {
      if (p.branch === null) return;
      await observeLand({
        projectId: p.projectId,
        bindingId: p.bindingId,
        branch: p.branch,
        commit: p.commit ?? undefined,
      });
    },
  });
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
