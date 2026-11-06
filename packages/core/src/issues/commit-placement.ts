import { portSlot } from '../lib/port-slot.js';

/**
 * Where a commit a verdict names stands against its issue's recorded landing (ISS-981), as release-batch
 * reads it (`release-batch/verdict-commit-placement.ts`): by the landings Forge recorded, then by the
 * project's ancestry reader. `holds`: the commit holds the landing; `carried`: the landing descends
 * from the commit; `placed: false`: the reader answered neither; `unread`: nobody could say, and why.
 */
export type CommitPlacedOnLanding = (
  projectId: string,
  landing: string,
  commit: string,
) => Promise<
  { placed: true; how: 'landing' | 'holds' | 'carried' } | { placed: false } | { unread: string }
>;

const slot = portSlot<{ commitPlacedOnLanding: CommitPlacedOnLanding }>(
  'issues',
  'provideCommitPlacement',
);
export const provideCommitPlacement = slot.provide;
export const commitPlacedOnLanding = slot.port('commitPlacedOnLanding');
