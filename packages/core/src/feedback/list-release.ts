/** The release facts a page of feedback reads: how the project releases where a carrier waits at the gate, who may make that release, and the release each shipped carrier went out in. */

import { RELEASE_ACT_PERMISSION } from '@forge/contracts/forecast';
import { type OwedBy, type OwedPolicy, whoOwes } from '@forge/contracts/who-owes';
import { releaseNotesOf, waitingIssueIds } from '../issues/index.js';
import { holderNames } from '../permissions/index.js';
import { shippedReleasesOf } from '../pipeline/index.js';
import { readReleaseMode } from '../project-config/index.js';
import type { CarrierRelease } from './standing.js';

export type ReleaseGate = {
  release: CarrierRelease | null;
  releaseHolders: string[];
  /** Who owes the `manual` model's cut (`releaseCutOf`); null under any other model. */
  releaseCut: OwedBy | null;
};

/** How this project's release is made, read only where a routed issue waits at the gate, who holds the permission its person act takes, and who owes a manual cut. */
export async function releaseGateOf(
  projectId: string,
  atGate: boolean,
  policy: Promise<OwedPolicy>,
): Promise<ReleaseGate> {
  const release = atGate ? await readReleaseMode(projectId) : null;
  const [releaseHolders, releaseCut] = await Promise.all([
    release && release !== 'automatic'
      ? holderNames(RELEASE_ACT_PERMISSION[release], projectId)
      : [],
    release === 'manual' ? policy.then((p) => releaseCutOf(projectId, p)) : null,
  ]);
  return { release, releaseHolders, releaseCut };
}

/**
 * Who owes the `manual` model's cut (ISS-1244): the one rule (`who-owes.ts:whoOwes`, `release.cut`)
 * the release page reads its draft's cut by (ISS-1232), with the project's policy and what the roster
 * that cut carries says cannot be undone, so every item and the release name one owner.
 */
async function releaseCutOf(projectId: string, policy: OwedPolicy): Promise<OwedBy> {
  const notes = await releaseNotesOf(await waitingIssueIds(projectId));
  const irreversible = [
    ...new Set(
      [...notes.values()].flatMap((n) =>
        n.releaseNotes?.irreversible ? [n.releaseNotes.irreversible] : [],
      ),
    ),
  ];
  return whoOwes('release.cut', policy, { irreversible });
}

/** A finished release lets its claim go, so a carrier it shipped is read where the issue reads it. */
export const shippedCarriersOf = shippedReleasesOf;
