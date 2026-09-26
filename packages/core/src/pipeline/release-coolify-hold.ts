/** The environment hold a release dispatch takes and gives back (ISS-1279). */

import { readDeployHolds } from './deploy-confirmations.js';
import { deployHoldsIdle, readDeployLocksHeld, releaseDeployLocksForRun } from './deploy-lock.js';

/** Each binding's stages, plus `live` for one `reachesLive` says reaches production. */
export interface DeployLockIntent {
  projectId: string;
  environments: string[];
  subject: string;
}

type LockableBinding = { id: string; stages: string[] | null; role: string; config: unknown };

export function deployLockIntent(
  projectId: string,
  pairs: ReadonlyArray<{ binding: LockableBinding }>,
  reachesLive: (binding: { stages: string[] | null; config: unknown }) => boolean,
): DeployLockIntent {
  const environments = new Set<string>();
  for (const { binding } of pairs) {
    for (const stage of binding.stages ?? []) environments.add(stage);
    if (reachesLive(binding)) environments.add('live');
  }
  const subject = pairs
    .map(({ binding }) => `${targetLabelOf(binding)} (binding ${binding.id})`)
    .join(', ');
  return { projectId, environments: [...environments].sort(), subject };
}

export const targetLabelOf = (binding: { stages: string[] | null; role: string }): string =>
  `${(binding.stages ?? []).join('+') || binding.role} deploy`;

/** Nothing queued is all a count may answer; past that the holds record what reaches the
 *  environment. An empty record behind a dispatch that DID queue is a deploy no hold tracks. */
export async function freeLockIfNothingPending(
  lock: DeployLockIntent | null,
  runId: string,
  dispatched: readonly string[],
): Promise<void> {
  if (!lock) return;
  // Read before the record, so a lock taken since is not freed by a record that predates it; and
  // narrowed to what THIS dispatch took, an earlier one of the same run may still be deploying.
  const heldLocks = await readDeployLocksHeld(runId);
  if (dispatched.length === 0) {
    await releaseDeployLocksForRun(
      runId,
      heldLocks.filter((h) => lock.environments.includes(h.environment)),
    );
    return;
  }
  if (deployHoldsIdle(await readDeployHolds(runId))) {
    await releaseDeployLocksForRun(runId, heldLocks);
  }
}
