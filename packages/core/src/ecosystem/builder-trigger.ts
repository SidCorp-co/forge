/** A push to a member project's default branch reopens its builder runs (ISS-39). */

import { db } from '../db/client.js';
import { logger } from '../observability/logger.js';
import { openOwedRun } from './link-service.js';
import { membershipsWhere } from './membership-store.js';
import { ecosystemSignals } from './ports.js';

const COMMIT = /^[0-9a-f]{40}$/;
const NO_COMMIT = /^0{40}$/;

// cm:why a push re-reads the project's own code, so only its default branch counts; a payload that does not name that branch is skipped and said, never read as a push to it
export async function openPushedRuns(input: {
  projectId: string;
  branch: string;
  defaultBranch: string | null;
  commit: string | undefined;
}): Promise<number> {
  const { projectId, branch, defaultBranch, commit } = input;
  if (!commit || NO_COMMIT.test(commit) || !COMMIT.test(commit)) return 0;
  if (defaultBranch === null) {
    logger.warn(
      { projectId, branch },
      'push names no repository.default_branch — no ecosystem builder run opened for it',
    );
    return 0;
  }
  if (branch !== defaultBranch) return 0;
  const active = (await membershipsWhere({ projectIds: [projectId] })).filter(
    (m) => m.state === 'active',
  );
  if (active.length === 0) return 0;
  let opened = 0;
  for (const m of active) {
    const run = await db.transaction((tx) =>
      openOwedRun(tx, {
        ecosystemId: m.ecosystemId,
        projectId,
        trigger: { kind: 'push', sha: commit },
        userId: m.decidedBy ?? m.invitedBy,
      }),
    );
    if (run.opened) opened += 1;
  }
  if (opened > 0) await ecosystemSignals().wakeForBuild(projectId);
  return opened;
}
