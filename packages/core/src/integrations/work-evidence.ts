import { portSlot } from '../lib/port-slot.js';

// What an adapter tells Forge's own work about a fact it recorded, handed in by the process entry at
// boot, so no adapter imports the module that owns the work (ADR 0008).

interface WorkEvidence {
  /**
   * A change request is open for these issues: a change being built, so an in-progress issue's step
   * moves forward to build, never back (ISS-951 round 2).
   */
  changeRequestOpen(issueIds: readonly string[]): Promise<void>;
}

const slot = portSlot<WorkEvidence>('integrations', 'provideWorkEvidence');
export const provideWorkEvidence = slot.provide;
export const workEvidence = slot.get;
