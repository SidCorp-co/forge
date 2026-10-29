/** The release facts a page of feedback reads: how the project releases where a carrier waits at the gate, who may make that release, and the release each shipped carrier went out in. */

import { RELEASE_ACT_PERMISSION } from '@forge/contracts/forecast';
import { holderNames } from '../permissions/index.js';
import { shippedReleasesOf } from '../pipeline/index.js';
import { readReleaseMode } from '../project-config/index.js';
import type { CarrierRelease } from './standing.js';

export type ReleaseGate = { release: CarrierRelease | null; releaseHolders: string[] };

/** How this project's release is made, read only where a routed issue waits at the gate, and who holds the permission its person act takes. */
export async function releaseGateOf(projectId: string, atGate: boolean): Promise<ReleaseGate> {
  const release = atGate ? await readReleaseMode(projectId) : null;
  const releaseHolders =
    release && release !== 'automatic'
      ? await holderNames(RELEASE_ACT_PERMISSION[release], projectId)
      : [];
  return { release, releaseHolders };
}

/** A finished release lets its claim go, so a carrier it shipped is read where the issue reads it. */
export const shippedCarriersOf = shippedReleasesOf;
