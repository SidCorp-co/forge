/** A push to a member project's default branch reopens its builder runs (ISS-39). */

import type { Tx } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { emitEvent } from '../outbox/index.js';
import { openOwedRun } from './link-service.js';
import { membershipsWhere } from './membership-store.js';

const COMMIT = /^[0-9a-f]{40}$/;
const NO_COMMIT = /^0{40}$/;

// a push re-reads the project's own code, so only its default branch counts; a payload that does not name that branch is skipped and said, never read as a push to it
export async function openPushedRuns(
  tx: Tx,
  input: {
    projectId: string;
    branch: string;
    defaultBranch: string | null;
    commit: string | undefined;
  },
): Promise<void> {
  const { projectId, branch, defaultBranch, commit } = input;
  if (!commit || NO_COMMIT.test(commit) || !COMMIT.test(commit)) return;
  if (defaultBranch === null) {
    logger.warn(
      { projectId, branch },
      'push names no repository.default_branch — no ecosystem builder run opened for it',
    );
    return;
  }
  if (branch !== defaultBranch) return;
  const active = (await membershipsWhere({ projectIds: [projectId] })).filter(
    (m) => m.state === 'active',
  );
  if (active.length === 0) return;
  for (const m of active) {
    await openOwedRun(tx, {
      ecosystemId: m.ecosystemId,
      projectId,
      trigger: { kind: 'push', sha: commit },
      userId: m.decidedBy ?? m.invitedBy,
    });
  }
  // every active membership now holds an open run, opened here or before, so a redelivered push wakes the master whether or not this attempt opened it
  await emitEvent(tx, 'ecosystem.buildOwed', { projectId });
}
