// A test double for `owner-boxes.ts`: every box able to own the release unless a case says
// otherwise. A readiness suite mocks the module with `() => import('./owner-boxes.fixture.js')`.

import { vi } from 'vitest';
import type * as OwnerBoxes from './owner-boxes.js';

const actual = await vi.importActual<typeof OwnerBoxes>('./owner-boxes.js');

export const ABLE_BOX: OwnerBoxes.OwnerBox = {
  deviceId: 'dev-1',
  deviceName: 'box-1',
  labelled: false,
  reason: null,
  detail: null,
  returnAtMs: null,
};

export const ownerCandidates = vi.fn(
  async (_projectId: string, label: string | null): Promise<OwnerBoxes.OwnerCandidates> => ({
    label,
    preferenceMet: label === null,
    boxes: [ABLE_BOX],
    eligible: [ABLE_BOX],
  }),
);

export const { classifyOwnerBox, eligibleOwners, noOwnerSentence, ownerBoxClause, readingOf } =
  actual;
export const { readBoxCapabilities, requireReleaseOwners, RELEASE_ROLE } = actual;
export const readOwnerCandidates = ownerCandidates;
