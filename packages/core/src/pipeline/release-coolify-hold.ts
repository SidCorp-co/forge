/** The environment hold a release dispatch takes and gives back (ISS-1279). */

import { readDeployHolds } from './deploy-confirmations.js';
import {
  type DeployLockHeld,
  deployHoldsIdle,
  deployHoldsLocks,
  releaseDeployLocksForRun,
} from './deploy-lock.js';

/** The project-document environment each binding deploys, which is what one deploy holds. */
export interface DeployLockIntent {
  projectId: string;
  environments: string[];
  subject: string;
}

type LockableBinding = { id: string; role: string };

export function deployLockIntent(
  projectId: string,
  pairs: ReadonlyArray<{ binding: LockableBinding }>,
  environmentOf: (binding: { id: string }) => string | null,
): DeployLockIntent {
  const environments = new Set<string>();
  for (const { binding } of pairs) {
    const env = environmentOf(binding);
    if (env !== null) environments.add(env);
  }
  const subject = pairs
    .map(
      ({ binding }) => `${targetLabelOf(environmentOf(binding), binding)} (binding ${binding.id})`,
    )
    .join(', ');
  return { projectId, environments: [...environments].sort(), subject };
}

export const targetLabelOf = (environment: string | null, binding: { role: string }): string =>
  `${environment ?? binding.role} deploy`;

/** Nothing queued is all a count answers; past that the holds record what reaches the
 *  environment, and an empty one behind a dispatch that DID queue is a deploy no hold tracks. */
export async function freeLockIfNothingPending(
  lock: DeployLockIntent | null,
  runId: string,
  dispatched: readonly string[],
  taken: readonly DeployLockHeld[],
): Promise<void> {
  if (!lock) return;
  // `taken`, never a fresh read: stalled past its expiry it would give back a SUCCESSOR's.
  if (dispatched.length === 0) {
    await releaseDeployLocksForRun(runId, taken);
    return;
  }
  const holds = await readDeployHolds(runId);
  if (deployHoldsIdle(holds)) await releaseDeployLocksForRun(runId, deployHoldsLocks(holds));
}

/** An environment taken for a binding that then parked is one nobody is deploying to. Left held,
 *  it refuses the confirmation resuming it, in the name of the run waiting to press it. */
export async function giveBackUnusedEnvironments(
  runId: string,
  taken: readonly DeployLockHeld[],
  needed: readonly string[],
): Promise<void> {
  const surplus = taken.filter((h) => !needed.includes(h.environment));
  if (surplus.length === 0) return;
  await releaseDeployLocksForRun(runId, surplus);
}

/** The rows a binding's deploy needs, so its placeholder records what it alone may free. */
export const locksOf = (
  taken: readonly DeployLockHeld[],
  needs: DeployLockIntent,
): DeployLockHeld[] => taken.filter((h) => needs.environments.includes(h.environment));
