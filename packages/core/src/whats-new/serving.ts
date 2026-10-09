/**
 * Which release this Forge instance is serving (REQ-40 BC-10): the release of the instance's own
 * product project whose commit is the one this build was made from. The instance names both facts
 * itself (`FORGE_ENVIRONMENT`, `FORGE_PRODUCT_PROJECT_ID`); nothing is inferred from the projects it
 * holds, and a build that is no release's commit serves none.
 */

import type { WhatsNewRefusalCode } from '@forge/contracts/whats-new';
import { env } from '../lib/env.js';
import { refuser } from '../lib/refusal.js';
import { sourceCommit } from '../lib/source-commit.js';
import {
  deploymentConfirms,
  type ShippedReleaseRun,
  shippedReleaseRuns,
} from '../release-batch/index.js';

const refuseWhatsNew = refuser<WhatsNewRefusalCode>('WHATS_NEW_REFUSED');

export interface ServingRelease {
  projectId: string;
  version: string;
}

export interface ServingReading {
  /** The instance's own name for where it runs, or null where it declares none. */
  environment: string | null;
  /** The release this build is, or null where the project is unset, or no release carries this commit. */
  release: ServingRelease | null;
}

/** The newest shipped release whose commit `built` is, or null: a build with no commit is no release. */
export function releaseOfBuild(
  shipped: readonly ShippedReleaseRun[],
  built: string | null,
): ShippedReleaseRun | null {
  if (built === null) return null;
  const matches = shipped.filter((r) => deploymentConfirms(r.commit, built));
  return matches.at(-1) ?? null;
}

/** What this instance serves, without refusing where it declares nothing: the seen-mark rule reads this. */
export async function readServing(
  built: string | null = sourceCommit,
  shipped: (projectId: string) => Promise<ShippedReleaseRun[]> = shippedReleaseRuns,
): Promise<ServingReading> {
  const environment = env.FORGE_ENVIRONMENT ?? null;
  const projectId = env.FORGE_PRODUCT_PROJECT_ID ?? null;
  if (projectId === null) return { environment, release: null };
  const run = releaseOfBuild(await shipped(projectId), built);
  return { environment, release: run ? { projectId, version: run.version } : null };
}

/** What this instance serves, refused by name where it does not say which environment it is or which project is its own. */
export async function requireServing(
  built?: string | null,
  shipped?: (projectId: string) => Promise<ShippedReleaseRun[]>,
): Promise<ServingReading & { environment: string }> {
  const missing = [
    env.FORGE_ENVIRONMENT === undefined
      ? 'FORGE_ENVIRONMENT (its own name: dev, beta, production)'
      : null,
    env.FORGE_PRODUCT_PROJECT_ID === undefined
      ? 'FORGE_PRODUCT_PROJECT_ID (the id of the project that holds its own releases)'
      : null,
  ].filter((m) => m !== null);
  if (missing.length > 0) {
    throw refuseWhatsNew(
      'WHATS_NEW_INSTANCE_UNSET',
      `this instance does not say which release it serves: set ${missing.join(' and ')}; What's new reads the release of that project whose commit this build is`,
    );
  }
  const reading = await readServing(built, shipped);
  return { ...reading, environment: reading.environment as string };
}
