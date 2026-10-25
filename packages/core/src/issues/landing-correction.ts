// What corrects a recorded landing the repository does not hold, in the issue page's own words: the
// issue's hold, the release readiness page and the release-create refusal all read it here.

import { MARK_MERGED_ACTION, UNMARK_ACTION } from '@forge/contracts/mark-merged-words';
import { ISSUE_STATUS_LABELS } from './status-sets.js';
import type { LandingRecord } from './verdict-standing.js';

export interface UnresolvedLandingRef {
  readonly commit: string;
  readonly repository: string;
  readonly from: LandingRecord;
}

export function landingCorrection(from: LandingRecord): string {
  return from === 'merge'
    ? `A person uses ${UNMARK_ACTION} in the issue's properties, then ${MARK_MERGED_ACTION} at the commit that landed.`
    : `A person uses ${MARK_MERGED_ACTION} in the issue's properties, at the commit that landed.`;
}

export function landingRecordName(from: LandingRecord): string {
  return from === 'merge' ? 'the merge mark' : 'the landing record';
}

export function unresolvedLandingLine(displayId: string, landing: UnresolvedLandingRef): string {
  return `\`${displayId}\` records ${landing.commit} as landed, which ${landing.repository} does not hold, so no verdict can be weighed until ${landingRecordName(landing.from)} is corrected. ${landingCorrection(landing.from)}`;
}

export const LANDINGS_LEAD = `The automatic release cuts nothing until each issue at ${ISSUE_STATUS_LABELS.awaiting_release} records the commit it landed at.`;

export interface LandingHeld {
  readonly displayId: string;
  readonly unresolvedLanding?: UnresolvedLandingRef;
}

/** Each line starts with a space, so it follows the sentence it is put beside. */
export function splitLandings<T extends LandingHeld>(
  held: readonly T[],
): { owing: T[]; landings: string } {
  const lines = held.flatMap((h) =>
    h.unresolvedLanding ? [` ${unresolvedLandingLine(h.displayId, h.unresolvedLanding)}`] : [],
  );
  return { owing: held.filter((h) => !h.unresolvedLanding), landings: lines.join('') };
}
