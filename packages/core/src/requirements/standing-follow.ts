/**
 * The words a requirement's act uses when a design or contract it follows has moved on: what the
 * signer does, and what doing it changes. Split from `standing.ts` to keep that file one read.
 */

import { FOLLOW_NEWER_DESIGN_ACT } from '@forge/contracts/requirements';

/** What a signer does about a pin that fell behind, in the words a BA reads: the design's own name and revision. */
export function updateToApprovedAct(
  designs: readonly { title: string; approved: number }[],
  contracts: readonly { contract: string; current: string }[],
): string {
  const parts = [
    ...designs.map((p) => `${FOLLOW_NEWER_DESIGN_ACT}: ${p.title} (revision ${p.approved})`),
    ...contracts.map((p) => `Update to the current version of ${p.contract} (${p.current})`),
  ];
  return parts.join('; ');
}

/** What pressing "update" really does (`repin.ts`): a new baseline of the same agreed revision pins the newer ones; nothing in the wording or criteria is rewritten. */
export function updateToApprovedEffect(
  designs: readonly { title: string; approved: number }[],
  contracts: readonly { contract: string; current: string }[],
): string {
  const names = [
    ...designs.map((p) => `${p.title} revision ${p.approved}`),
    ...contracts.map((p) => `${p.contract} ${p.current}`),
  ].join(', ');
  return `Records that this requirement follows ${names} from now on. Its wording and criteria do not change, and its delivery is not offered for acceptance until then.`;
}
