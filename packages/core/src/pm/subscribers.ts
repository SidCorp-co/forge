import type { HooksBus } from '../pipeline/hooks.js';
import { handlePmJobFailedAutoDisable } from './auto-disable.js';
import { spawnPmSession } from './spawner.js';

/**
 * Wire PM spawn triggers onto the hooks bus. Three subscribers:
 *
 *  - `jobFailed` → spawn with `cause='job-failed'`. PM-on-PM failures route
 *    to the three-strikes auto-disable guard instead, never to a new spawn
 *    (would loop on a misbehaving PM model).
 *  - `transition` → filter to `needs_info` and spawn with that cause.
 *    (`pipeline_failed` was the old recovery-exhausted signal; the failure
 *    model now reverts to the stage entry-status or parks at `waiting`
 *    (ISS-393), so this branch is gone. A `waiting`-targeted spawn may be
 *    added in a follow-up if PM should auto-engage on parked issues.)
 *  - `dependencyChanged` → spawn with `cause='graph-changed'`.
 *
 * Note: `jobCompleted` is intentionally NOT subscribed in v1. The payload
 * is declared so Epic 5 (escalation resolution) can subscribe later without
 * a hook-bus change.
 */
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
