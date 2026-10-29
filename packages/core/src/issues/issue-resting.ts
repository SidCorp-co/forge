/**
 * No run takes an issue at rest (FB-273).
 *
 * The status list is `ISSUE_RESTING_STATUSES`, the one core's recovery verdict reads to call a
 * declaration stale (`issue-lease-read.ts:readIssueStanding`). Refused here, at the preflight and
 * the open, a take is refused to the master that declared it, by name, before a row exists. A run
 * declared `qa` judges, takes no issue that is over and is not asked about it; one naming no role
 * over issues that are every one over takes nothing either (`devices/run-session.ts:takenBy`,
 * ISS-576).
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

/** The roles whose run judges and builds nothing; a shipped role may carry its plugin's prefix. */
export const JUDGING_RUN_ROLES = ['qa'] as const;

/** Does a run declared as `role` judge only: `qa` or `forge:qa`. */
export function judgesOnly(role: string): boolean {
  const bare = role.slice(role.lastIndexOf(':') + 1);
  return (JUDGING_RUN_ROLES as readonly string[]).includes(bare);
}

function remedy(status: IssueStatus, role: string | undefined): string {
  if (PARK_STATUSES.includes(status)) {
    return 'Return it from its park first (answer what it waits on), then declare again';
  }
  // never "reopen it to judge it" (forge-core-61, 2026-10-29, `VISION: state-never-lies`)
  const builds = role ? `A \`${role}\` run builds, and no build works an issue that is over. ` : '';
  return `${builds}To judge it, declare the run with \`--role qa\`: a judge carries it untaken, writes verdicts on it and moves no status, and a fail verdict reopens it through the finding path for a build to take`;
}

/** Every asked issue at rest, refused by name in one envelope; `null` where none is. */
export function restingRefusal(
  asked: readonly RestingCandidate[],
  door: string,
  role?: string,
): RefusalError | null {
  const resting = asked.filter((i) => ISSUE_RESTING_STATUSES.includes(i.status));
  if (resting.length === 0) return null;
  return new RefusalError(
    resting.map((i) => ({
      code: AT_REST,
      path: '',
      detail: `${door} is refused. ${i.issueKey} is at \`${i.status}\` (${ISSUE_STATUS_LABELS[i.status]}), which is at rest: no run works an issue at ${ISSUE_RESTING_STATUSES.map((s) => `\`${s}\``).join(', ')}. ${remedy(i.status, role)}. Nothing was recorded.`,
    })),
    AT_REST,
  );
}
