/**
 * A run is never opened over an issue at rest (FB-273).
 *
 * The status list is `ISSUE_RESTING_STATUSES`, the one core's recovery verdict reads to call a
 * declaration stale (`issue-lease-read.ts:readIssueStanding`). A box's run declared over a closed
 * issue was accepted, its subagent bound, and the verdict then closed the run under the working
 * subagent because its issue was over. Refused here, at the preflight and the open, it is refused to
 * the master that declared it, by name, before a row exists.
 */

import { ISSUE_RESTING_STATUSES, PARK_STATUSES } from '@forge/contracts/issue-machine';
import { ISSUE_STATUS_LABELS } from '@forge/contracts/issue-vocabulary';
import type { IssueTakeRefusalCode } from '@forge/contracts/issues';
import type { IssueStatus } from '../db/schema.js';
import { RefusalError } from '../lib/refusal.js';

const AT_REST = 'ISSUE_AT_REST' satisfies IssueTakeRefusalCode;

/** One issue a door was asked to take, as far as this refusal reads it. */
export interface RestingCandidate {
  issueKey: string;
  status: IssueStatus;
}

function remedy(status: IssueStatus): string {
  return PARK_STATUSES.includes(status)
    ? 'Return it from its park first (answer what it waits on), then declare again'
    : 'Reopen it first, then declare again';
}

/** Every asked issue at rest, refused by name in one envelope; `null` where none is. */
export function restingRefusal(
  asked: readonly RestingCandidate[],
  door: string,
): RefusalError | null {
  const resting = asked.filter((i) => ISSUE_RESTING_STATUSES.includes(i.status));
  if (resting.length === 0) return null;
  return new RefusalError(
    resting.map((i) => ({
      code: AT_REST,
      path: '',
      detail: `${door} is refused. ${i.issueKey} is at \`${i.status}\` (${ISSUE_STATUS_LABELS[i.status]}), which is at rest: no run works an issue at ${ISSUE_RESTING_STATUSES.map((s) => `\`${s}\``).join(', ')}. ${remedy(i.status)}. Nothing was recorded.`,
    })),
    AT_REST,
  );
}
