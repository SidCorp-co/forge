// What corrects a recorded landing the repository does not hold, in the issue page's own words: the
// issue's hold, the release readiness page and the release-create refusal all read it here.

import {
  COMMIT_FIELD,
  LATER_MERGE_ACTION,
  MARK_MERGED_ACTION,
} from '@forge/contracts/mark-merged-words';
import { ISSUE_STATUS_LABELS } from './status-sets.js';
import type { LandingRecord } from './verdict-standing.js';

export interface UnresolvedLandingRef {
  readonly commit: string;
  readonly repository: string;
  readonly from: LandingRecord;
}

/** The act that stores the commit a person names, read ahead of the record it corrects (ISS-1300 r3). */
export function landingCorrection(from: LandingRecord): string {
  return from === 'merge'
    ? `A person uses ${LATER_MERGE_ACTION} in the issue's properties, and names the commit that landed under ${COMMIT_FIELD}.`
    : `A person uses ${MARK_MERGED_ACTION}, or ${LATER_MERGE_ACTION} once marked, and names the commit that landed under ${COMMIT_FIELD}.`;
}

/** A recorded landing whose bound repository refused the read (ISS-1300 r3). */
export interface UnreadLandingRef {
  readonly repository: string | null;
  readonly why: string;
  readonly clears: string;
}

const named = (repository: string | null) => repository ?? "this project's repository";

export function unreadLandingClause(commit: string, landing: UnreadLandingRef): string {
  return `whether ${named(landing.repository)} holds ${commit}, the commit this issue records as landed, could not be read: ${landing.why}`;
}

export function unreadLandingClears(landing: UnreadLandingRef): string {
  return `Forge cannot read ${named(landing.repository)}, and reads it again ${landing.clears}`;
}

/** A release check its repository refused, in the same words; null where the read was not refused. */
export function refusedCheckClause(details?: {
  repository?: unknown;
  clears?: unknown;
  detail?: unknown;
}): string | null {
  if (typeof details?.clears !== 'string') return null;
  const repository = typeof details.repository === 'string' ? details.repository : null;
  const cannot = unreadLandingClears({
    repository,
    why: String(details.detail ?? ''),
    clears: details.clears,
  });
  return `${cannot}. Until then this answer cannot say whether a release would start: whatever that check would have found is missing from this list.`;
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
