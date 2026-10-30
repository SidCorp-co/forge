/**
 * No run takes an issue at rest (FB-273).
 *
 * The status list is `ISSUE_RESTING_STATUSES`, the one core's recovery verdict reads to call a
 * declaration stale (`issue-lease-read.ts:readIssueStanding`). Refused here, at the preflight and
 * the open, a take is refused to the master that declared it, by name, before a row exists. A run
 * declared to judge (`qa`, `reviewer`) takes no issue that is over and is not asked about it; one
 * naming no role over issues that are every one over takes nothing either
 * (`devices/run-take.ts:takenBy`, ISS-576).
 */

import type { CriterionJudge } from '@forge/contracts/issue-design';
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

/**
 * The roles whose run judges and builds nothing, each with the judge its verdicts are recorded as: a
 * `qa` run judges on the running build, a `reviewer` run judges a code property against the diff
 * (REQ-36 BC-13, `criteria/verdict-record.ts:misrouted`). A shipped role may carry its plugin's
 * prefix.
 */
export const JUDGING_RUN_ROLES = { qa: 'qa', reviewer: 'review' } as const satisfies Record<
  string,
  CriterionJudge
>;

/** The judge a run declared as `role` records its verdicts as; null for a role that builds. */
export function judgeOfRole(role: string): CriterionJudge | null {
  const bare = role.slice(role.lastIndexOf(':') + 1);
  return Object.hasOwn(JUDGING_RUN_ROLES, bare)
    ? JUDGING_RUN_ROLES[bare as keyof typeof JUDGING_RUN_ROLES]
    : null;
}

/** Does a run declared as `role` judge only: `qa`, `reviewer`, or either with its plugin prefix. */
export function judgesOnly(role: string): boolean {
  return judgeOfRole(role) !== null;
}

/** The two ways an issue that is over is judged, each by the role its criteria's class routes to. */
export const JUDGE_ROUTES =
  'declare the run with `--role qa` for a criterion judged on the running build, or `--role reviewer` for a code-property criterion judged against the diff';

function remedy(status: IssueStatus, role: string | undefined): string {
  if (PARK_STATUSES.includes(status)) {
    return 'Return it from its park first (answer what it waits on), then declare again';
  }
  // never "reopen it to judge it" (forge-core-61, 2026-10-29, `VISION: state-never-lies`)
  const builds = role ? `A \`${role}\` run builds, and no build works an issue that is over. ` : '';
  return `${builds}To judge it, ${JUDGE_ROUTES}: a judge carries it untaken, writes verdicts on it and moves no status, and a fail verdict reopens it through the finding path for a build to take`;
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
