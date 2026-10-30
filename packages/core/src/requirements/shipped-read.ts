// Which release shipped each issue of a requirement, read off the release runs the pipeline owns
// (`pipeline/release-runs.ts:shippedReleasesOf`), so a requirement and its issues name the release
// that delivered them (FB-102).

import type { OtherProject } from '@forge/contracts/requirements';
import { type ShippedRelease, shippedReleasesOf } from '../pipeline/index.js';
import { requirementDependents } from './dependents.js';
import type { IssueNaming } from './issue-projects.js';

export { type ShippedRelease, shippedReleasesOf };

/**
 * Each release that shipped one of its issues, once, oldest ship first; one of another project's
 * (a sibling project delivering the requirement, `issue-projects.ts`) names that project, since its
 * versions are its own and say nothing of the requirement project's.
 */
export function releasesOf(
  shipped: ReadonlyMap<string, ShippedRelease>,
  linked: readonly { id: string; projectId: string }[],
  naming: IssueNaming,
): (ShippedRelease & { otherProject: OtherProject | null })[] {
  const projectOf = new Map(linked.map((i) => [i.id, i.projectId]));
  const once = new Map<string, ShippedRelease & { otherProject: OtherProject | null }>();
  for (const [issueId, r] of shipped) {
    const at = projectOf.get(issueId) ?? naming.projectId;
    const otherProject = at === naming.projectId ? null : (naming.others.get(at)?.project ?? null);
    once.set(`${at}\u0000${r.version}`, { ...r, otherProject });
  }
  return [...once.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** What delivered each issue: the release that shipped it, or the landing that closed it where the
 *  project declares no production environment, which has a branch and commit but no version. */
export interface Delivered {
  shipped: ReadonlyMap<string, ShippedRelease>;
  landed: ReadonlyMap<string, { branch: string; commit: string; at: string }>;
}

/** What delivered each of `linked`, each read on its own project's releases. */
export async function deliveredOf(
  linked: readonly { id: string; projectId: string }[],
): Promise<Delivered> {
  const byProject = new Map<string, string[]>();
  for (const i of linked) byProject.set(i.projectId, [...(byProject.get(i.projectId) ?? []), i.id]);
  const [shipped, landed] = await Promise.all([
    Promise.all([...byProject].map(([projectId, ids]) => shippedReleasesOf(projectId, ids))),
    requirementDependents().landedRecordsOf(linked.map((i) => i.id)),
  ]);
  return { shipped: new Map(shipped.flatMap((m) => [...m])), landed };
}
