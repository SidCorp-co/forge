// The release a run session opened over exactly its roster takes with it (ISS-1281): asked before
// the open and again inside its transaction, so a refused take rolls the whole open back.

import type { Tx } from '../db/client.js';
import { OWNED_RELEASE_KEY } from '../release-batch/owner-record.js';
import {
  noteTakeRefused,
  type ReleaseAdoption,
  ReleaseOwnershipRefusedError,
  takeReleaseOwnership,
} from '../release-batch/owner-take.js';

export { type ReleaseAdoption, releaseAdoption } from '../release-batch/owner-take.js';

export function releaseRunMetadata(release: ReleaseAdoption | null): Record<string, string> {
  return release ? { [OWNED_RELEASE_KEY]: release.releaseRunId } : {};
}

export async function takeReleaseInOpen(
  tx: Tx,
  release: ReleaseAdoption | null,
  opened: { deviceId: string; sessionId: string; runId: string },
): Promise<void> {
  if (!release) return;
  await takeReleaseOwnership(tx, {
    releaseRunId: release.releaseRunId,
    deviceId: opened.deviceId,
    deviceName: release.deviceName,
    sessionId: opened.sessionId,
    runId: opened.runId,
    preferenceMet: release.preferenceMet,
  });
}

/** After the open rolled back, a refused take is written on the release that refused it. */
export async function noteRefusedTake(
  err: unknown,
  release: ReleaseAdoption | null,
  deviceId: string,
): Promise<void> {
  if (err instanceof ReleaseOwnershipRefusedError && release) {
    await noteTakeRefused(err, { deviceId, deviceName: release.deviceName });
  }
}
