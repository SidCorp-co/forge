// Whether a release counts each live criterion's standing verdict, read by the one rule every count of
// proof reads (contracts `verified-rule.ts:verifiedOf`, given the issue's last reopen), so the issue's
// criteria read and the release record (`release-batch/release-facts.ts:criteriaAt`) cannot disagree.
// A judge reads it to know which criteria still need a verdict: a pass voided by a reopen, or the
// builder's own pass, does not count, and it says why. A release besides reads only the verdicts at
// its own build. A pass that counts only under the builder-pass cutover
// (`verified-rule.ts:BUILDER_PASS_CUTOVER`) is marked, so a judge sees whose pass it is.

import {
  countedUnderCutover,
  releaseCounts,
  UNRESOLVED_COMMIT_WHY,
  verifiedOf,
} from '@forge/contracts/verified-rule';
import type { Tx } from '../../db/client.js';
import { readJudge } from '../ports.js';
import { reopenedAtOf } from '../release-evidence.js';
import { liveVerdictsOf } from './store.js';

/** How a release counts one criterion's verdicts. */
export interface CriterionCounting {
  /** Whether the verdict the criterion stands on proves it. */
  counted: boolean;
  /** Where its newest pass or short does not count, why; null where it counts, or is a fail, a skip or none. */
  why: string | null;
  /** The id of the pass it stands on where that pass counts only under the cutover; else null. */
  underCutover: string | null;
}

/** Each live criterion's counting, by its number; a criterion with no verdict is absent. */
export async function countingOf(
  executor: Pick<Tx, 'execute'>,
  issue: { id: string; projectId: string },
): Promise<Map<number, CriterionCounting>> {
  const [history, reopened, judge] = await Promise.all([
    liveVerdictsOf(executor, issue.id),
    reopenedAtOf(executor, [issue.id]),
    readJudge(issue.projectId),
  ]);
  const reopenedAt = reopened.get(issue.id) ?? null;
  const out = new Map<number, CriterionCounting>();
  for (const [n, newestFirst] of history) {
    const read = verifiedOf(newestFirst, judge, reopenedAt);
    const release = releaseCounts(read);
    const marked =
      release.counted && read.stands !== null && countedUnderCutover(read.stands, judge);
    out.set(n, {
      counted: release.counted,
      why: release.counted ? null : release.unresolved ? UNRESOLVED_COMMIT_WHY : read.why,
      underCutover: marked && read.stands ? read.stands.id : null,
    });
  }
  return out;
}
