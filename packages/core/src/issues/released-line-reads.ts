// What the issue kernel reads of a project's release record (ISS-900), provided at boot by the
// composition root as its other ports are (`ports.ts`): a verdict judged on a release is placed and
// weighed there.

import type { ReleasedLine } from '@forge/contracts/released-line';
import { portSlot } from '../lib/port-slot.js';

interface ReleasedLineReads {
  /**
   * Where the project's production names no commit it serves (no source probe), its shipped releases
   * and the one its record says is live, which a `release` verdict is placed and weighed on
   * (`release-batch/released-line.ts:releasedLineOf`); null on any other project.
   */
  releasedLine: (projectId: string) => Promise<ReleasedLine | null>;
  /** A release version as the record stores it (`v0.76.0` → `0.76.0`); null where the text is none. */
  releaseVersionOf: (text: string) => string | null;
}

const slot = portSlot<ReleasedLineReads>('issues', 'provideReleasedLineReads');
export const provideReleasedLineReads = slot.provide;
export const releasedLineOf = slot.port('releasedLine');
export const releaseVersionOf = slot.port('releaseVersionOf');
