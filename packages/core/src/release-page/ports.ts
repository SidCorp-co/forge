import type { ReleaseNamer } from '@forge/contracts/release-naming';
import { portSlot } from '../lib/port-slot.js';

// What the release page reads from the modules after release, handed in by the process entry at
// boot (ADR 0008): who names a release nobody named, which the steward's addressee decides by the
// permission naming takes (ISS-590). Read only inside a call.

interface ReleasePagePorts {
  /** Who names the project's unnamed releases: its master, its admins by name, or nobody. */
  releaseNamer(projectId: string): Promise<ReleaseNamer>;
}

const slot = portSlot<ReleasePagePorts>('release-page', 'provideReleasePagePorts');
export const provideReleasePagePorts = slot.provide;
export const releaseNamer = slot.port('releaseNamer');
