/**
 * When the commit a merge mark names landed, as its marker says (ISS-1226, FB-628).
 *
 * A mark recorded after the fact dated the landing at the mark, so a release cut between the two
 * read as cut before the landing, and a shipped-in record naming it was refused
 * (`release-batch/shipped-in.ts:refuseCutBeforeLanding`). Forge reads no commit (owner ruling
 * `release-is-the-agents-record`), so the marker says when it landed, and that time is the stamp
 * (`issues.merged_at`) the containment and a finish's `claimMarkedLate` read. Forge refuses only a
 * time not yet come. A landing before the issue was created is taken: an issue filed for a merge that
 * named none, a dev twin of a beta issue and a hand fix recorded after it landed all predate their
 * issue, and those late marks are the ones this time exists for.
 *
 * `mergedAt` is the spelling the plugin's `mark_merged` already sends for the same time, so it is held
 * to the same refusals; one call names at most one of the two. A closed issue's correction
 * (`merge-correction.ts`) names its landing the same way and is held to the same rule.
 */

import type { MergeRefusalCode } from '@forge/contracts/issues';
import { refuser } from '../lib/refusal.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

/** The two spellings of the landing a mark's body may carry, each an ISO datetime the schema read. */
export interface SentLanding {
  landedAt?: string | undefined;
  mergedAt?: string | undefined;
}

/**
 * The time the mark's commit landed, as its body names it, or null where it names none (the stamp is
 * then the time the mark is recorded, as before). Refused by name, before anything is written: both
 * spellings at once, and a time after now.
 */
export function landingOfMark(body: SentLanding, now: Date = new Date()): Date | null {
  if (body.landedAt && body.mergedAt) {
    throw refuse(
      'MERGE_LANDED_AT_TWICE',
      'when the commit landed is named once: send `landedAt` alone (`mergedAt` is the older spelling of the same time)',
      '/mergedAt',
    );
  }
  const path = body.landedAt ? '/landedAt' : '/mergedAt';
  const sent = body.landedAt ?? body.mergedAt;
  if (!sent) return null;
  const at = new Date(sent);
  if (at.getTime() > now.getTime()) {
    throw refuse(
      'MERGE_LANDED_AT_FUTURE',
      `${path.slice(1)} is ${at.toISOString()}, after now (${now.toISOString()}): a commit that has not landed yet is not marked. Send the time the commit landed on its branch, or omit it to date the landing now`,
      path,
    );
  }
  return at;
}
