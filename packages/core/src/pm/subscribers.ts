import type { HooksBus } from '../pipeline/hooks.js';
import { handlePmJobFailedAutoDisable } from './auto-disable.js';
import { spawnPmSession } from './spawner.js';

export function registerPmSubscribers(bus: HooksBus): void {
  bus.on('jobFailed', async (p) => {
    if (p.type === 'pm') {
      await handlePmJobFailedAutoDisable(p);
      return;
    }
    await spawnPmSession({
      projectId: p.projectId,
      cause: 'job-failed',
      eventRef: {
        jobId: p.jobId,
        jobType: p.type,
        failureKind: p.failureKind,
        issueId: p.issueId,
      },
    });
  });

  bus.on('transition', async (p) => {
    if (p.to === 'needs_info') {
      await spawnPmSession({
        projectId: p.projectId,
        cause: 'needs-info',
        eventRef: { issueId: p.issueId, from: p.from },
      });
    }
  });

  bus.on('dependencyChanged', async (p) => {
    await spawnPmSession({
      projectId: p.projectId,
      cause: 'graph-changed',
      eventRef: { edgeId: p.edgeId, from: p.fromIssueId, to: p.toIssueId, kind: p.kind },
    });
  });
}
