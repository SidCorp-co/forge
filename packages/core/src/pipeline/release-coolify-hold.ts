/** The environment hold a release dispatch takes and gives back (ISS-1279). */

import { readDeployHolds } from './deploy-confirmations.js';
import {
  type DeployLockHeld,
  deployHoldsIdle,
  deployHoldsLocks,
  readDeployLocksHeld,
  releaseDeployLocksForRun,
} from './deploy-lock.js';

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
  // Narrowed to what THIS dispatch took: an earlier one of the same run may still be deploying.
  const heldLocks = await readDeployLocksHeld(runId);
  if (dispatched.length === 0) {
    await releaseDeployLocksForRun(
      runId,
      heldLocks.filter((h) => lock.environments.includes(h.environment)),
    );
    return;
  }
  const holds = await readDeployHolds(runId);
  if (deployHoldsIdle(holds)) await releaseDeployLocksForRun(runId, deployHoldsLocks(holds));
}

/** An environment this dispatch took for a binding it then parked for a human is an environment it
 *  is not deploying to. Left held, it refuses the confirmation that resumes it — in the name of the
 *  very run waiting to press it — until the expiry (ISS-1279). */
export async function giveBackUnusedEnvironments(
  lock: DeployLockIntent | null,
  runId: string,
  needed: readonly string[],
): Promise<void> {
  if (!lock) return;
  const surplus = lock.environments.filter((e) => !needed.includes(e));
  if (surplus.length === 0) return;
  const held = await readDeployLocksHeld(runId);
  await releaseDeployLocksForRun(
    runId,
    held.filter((h) => surplus.includes(h.environment)),
  );
}

/** The rows a binding's deploy needs, so its placeholder records what it alone may free. */
export const locksOf = (
  taken: readonly DeployLockHeld[],
  needs: DeployLockIntent,
): DeployLockHeld[] => taken.filter((h) => needs.environments.includes(h.environment));
