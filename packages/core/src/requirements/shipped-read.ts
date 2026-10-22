// Which release shipped each issue of a requirement, read off the release runs the pipeline owns
// (`pipeline/release-runs.ts:shippedReleasesOf`), so a requirement and its issues name the release
// that delivered them (FB-102).

import { type ShippedRelease, shippedReleasesOf } from '../pipeline/index.js';
import { requirementDependents } from './dependents.js';

export { type ShippedRelease, shippedReleasesOf };

/** Each release that shipped one of its issues, once, oldest ship first. */
export function releasesOf(shipped: ReadonlyMap<string, ShippedRelease>): ShippedRelease[] {
  const byVersion = new Map([...shipped.values()].map((r) => [r.version, r]));
  return [...byVersion.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** What delivered each issue: the release that shipped it, or the landing that closed it where the
 *  project declares no production environment, which has a branch and commit but no version. */
export interface Delivered {
  shipped: ReadonlyMap<string, ShippedRelease>;
  landed: ReadonlyMap<string, { branch: string; commit: string; at: string }>;
}

export async function deliveredOf(
  projectId: string,
  linked: readonly { id: string }[],
): Promise<Delivered> {
  const ids = linked.map((i) => i.id);
  const [shipped, landed] = await Promise.all([
    shippedReleasesOf(projectId, ids),
    requirementDependents().landedRecordsOf(ids),
  ]);
  return { shipped, landed };
}
