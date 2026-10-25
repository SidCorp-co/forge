// Whether the project's delivery counts each live criterion's standing verdict, read by the one rule
// every count of proof reads (contracts `verified-rule.ts:verifiedOf`, given the issue's last reopen
// and how the project delivers, `voidedUnder`), so the issue's criteria read, the release record
// (`release-batch/release-facts.ts:criteriaAt`) and requirement coverage cannot disagree. Under
// release mode `none` the landing record is the delivery, and a pass at the landed commit counts.
// A judge reads it to know which criteria still need a verdict: a pass voided by a reopen, or the
// builder's own pass, does not count, and it says why. A release besides reads only the verdicts at
// its own build. A pass that counts only under the builder-pass cutover
// (`verified-rule.ts:BUILDER_PASS_CUTOVER`) is marked, so a judge sees whose pass it is.

import {
  countedUnderCutover,
  RELEASE_DELIVERY,
  releaseCounts,
  UNRESOLVED_COMMIT_WHY,
  verifiedOf,
} from '@forge/contracts/verified-rule';
import type { Tx } from '../../db/client.js';
import { proofDeliveriesOf, readJudge } from '../ports.js';
import { reopenedAtOf } from '../release-evidence.js';
import { liveVerdictsOf } from './store.js';

/** How the project's delivery counts one criterion's verdicts. */
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
  const [history, reopened, judge, deliveries] = await Promise.all([
    liveVerdictsOf(executor, issue.id),
    reopenedAtOf(executor, [issue.id]),
    readJudge(issue.projectId),
    proofDeliveriesOf(issue.projectId, [issue.id]),
  ]);
  const reopenedAt = reopened.get(issue.id) ?? null;
  const delivery = deliveries.get(issue.id.toLowerCase()) ?? RELEASE_DELIVERY;
  const out = new Map<number, CriterionCounting>();
  for (const [n, newestFirst] of history) {
    const read = verifiedOf(newestFirst, judge, reopenedAt, delivery);
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
