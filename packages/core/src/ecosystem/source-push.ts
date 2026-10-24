import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { readDeclaredSource } from '../project-config/index.js';
import { pushReading } from './builder-run-rules.js';
import { openPushedRuns } from './builder-trigger.js';

/**
 * The ecosystem's reaction to a push a source host reported: a push to the branch the project builds
 * from opens the builder runs, the same for every host, so a GitHub push and a GitLab push cannot
 * drift apart. The branch is the project document's, never the host's default branch.
 */
export function registerSourcePushReactions(): void {
  consume('source.pushed', {
    name: 'ecosystem-builder',
    handle: async (p, d) => {
      const { defaultBranch: buildBranch } = await readDeclaredSource(p.projectId);
      const reading = pushReading({
        projectId: p.projectId,
        branch: p.branch,
        buildBranch,
        commit: p.commit,
        at: new Date().toISOString(),
      });
      if (reading.kind === 'refused') {
        logger.warn(
          { projectId: p.projectId, branch: p.branch, code: reading.refusal.code },
          reading.refusal.detail,
        );
        return;
      }
      if (reading.kind === 'none') return;
      await d.inbox((tx) => openPushedRuns(tx, { projectId: p.projectId, reading }));
    },
  });
}
