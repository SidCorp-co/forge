/**
 * Which non-terminal statuses are watched for a stranded row, on what clock, and who owes the next
 * move. `Record<IssueStatus, StrandRule>`, so a status added to `issueStatuses` and left
 * unclassified is a typecheck failure rather than a row that falls out of the sweep — the hole
 * ISS-1122 was filed about, where `waiting` and three others were enumerated and the rest unread.
 */

import type { IssueStatus } from '../db/schema.js';
import type { LeaseReading } from './session-claim.js';

/** Whose move it is for a stranded row to leave the status it is stuck at. */
export type StrandOwner = 'agent' | 'human';

export type StrandRule =
  | {
      watch: false;
      /** Why nothing is owed here. A status left out with no reason is what this type forbids. */
      atRest: string;
    }
  | {
      watch: true;
      graceMs: number;
      /** Who owes the next move, absent evidence that says otherwise. */
      owes: StrandOwner;
      waitingFor: string;
    };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const STRAND_RULES: Record<IssueStatus, StrandRule> = {
  draft: {
    watch: false,
    atRest: 'filed and never started: a person decides whether it becomes work',
  },
  waiting: { watch: false, atRest: 'detectStrandedIssues in stranded-issues.ts owns this status' },
  on_hold: { watch: false, atRest: 'a deliberate pause, whose reason the row already carries' },
  needs_info: {
    watch: false,
    atRest: 'the status names what it waits for: a person owes an answer',
  },
  closed: { watch: false, atRest: 'terminal: the work is over and nothing is owed' },
  dropped: { watch: false, atRest: 'terminal: the work was abandoned and nothing is owed' },

  open: {
    watch: true,
    graceMs: 15 * MINUTE,
    owes: 'agent',
    waitingFor: 'a run to be dispatched onto it',
  },
  confirmed: { watch: true, graceMs: 6 * HOUR, owes: 'agent', waitingFor: 'a plan' },
  clarified: { watch: true, graceMs: 6 * HOUR, owes: 'agent', waitingFor: 'a plan' },
  approved: { watch: true, graceMs: 6 * HOUR, owes: 'agent', waitingFor: 'a run to build it' },
  in_progress: {
    watch: true,
    graceMs: 2 * HOUR,
    owes: 'agent',
    waitingFor: 'the run that claimed it',
  },
  developed: {
    watch: true,
    graceMs: 6 * HOUR,
    owes: 'agent',
    waitingFor: 'a run to judge it',
  },
  testing: { watch: true, graceMs: 6 * HOUR, owes: 'agent', waitingFor: 'verdicts' },
  tested: { watch: true, graceMs: 6 * HOUR, owes: 'agent', waitingFor: 'a release' },
  awaiting_release: {
    watch: true,
    graceMs: 48 * HOUR,
    owes: 'human',
    waitingFor: 'a person to release it',
  },
  releasing: { watch: true, graceMs: 2 * HOUR, owes: 'agent', waitingFor: 'the release run' },
  reopen: { watch: true, graceMs: 6 * HOUR, owes: 'agent', waitingFor: 'a run to build it again' },
};

export const AT_REST_STATUSES: readonly IssueStatus[] = (
  Object.keys(STRAND_RULES) as IssueStatus[]
).filter((s) => STRAND_RULES[s].watch === false);

export const WATCHED_STATUSES: readonly IssueStatus[] = (
  Object.keys(STRAND_RULES) as IssueStatus[]
).filter((s) => STRAND_RULES[s].watch === true);

/** The shortest clock any watched status runs on — the sweep's own far edge. */
export const SHORTEST_GRACE_MS: number = Math.min(
  ...WATCHED_STATUSES.map((s) => {
    const rule = STRAND_RULES[s];
    return rule.watch ? rule.graceMs : Number.POSITIVE_INFINITY;
  }),
);

/** `issues.status` is a `text` column, so a value `issueStatuses` has not caught up with is a row
 *  the database can hold: `null` rather than a guess, counted `unclassified` and logged by name. */
export function strandRuleFor(status: string): StrandRule | null {
  return Object.hasOwn(STRAND_RULES, status) ? (STRAND_RULES[status as IssueStatus] ?? null) : null;
}

/** What the pass could see about one row, and nothing it inferred. */
export interface StrandEvidence {
  merged: boolean;
  /** Whether any `pipeline_runs` row has ever existed for this issue, terminal or not. */
  everRan: boolean;
  /** Whether this project has a runner admitted to the job pool. */
  poolHasRunner: boolean;
  lease: LeaseReading;
}

/**
 * Why this row is where it is, drawn from {@link StrandEvidence} and never from the status alone.
 *
 * Two rows at one status can be stuck for different causes — one behind an unmerged pull request,
 * one behind a judge that was never dispatched — and a sentence keyed off the status would assert
 * a cause the pass did not observe. Where the evidence decides nothing, the last clause says so
 * rather than naming a cause, which is the same refusal-by-name the row itself gets.
 */
export function strandReason(args: {
  status: string;
  rule: StrandRule;
  evidence: StrandEvidence;
}): { reason: string; owes: StrandOwner } {
  const { status, rule, evidence } = args;
  const fallbackOwner: StrandOwner = rule.watch ? rule.owes : 'human';

  if (status === 'open' && !evidence.poolHasRunner) {
    return {
      reason: 'no runner is admitted to this project’s job pool, so no wake can be acted on',
      owes: 'human',
    };
  }
  if (status === 'open' && !evidence.everRan) {
    return {
      reason:
        'a runner is admitted and no run was ever opened for this issue: the dispatch did not happen',
      owes: 'agent',
    };
  }

  const lease = evidence.lease;
  if (lease.verdict === 'expired') {
    // What was read is the lease's own state, and nothing about the holder: an expiry says the
    // claim has lapsed, not that a run stopped, and a release stamp says it was given up, not by
    // whom or why.
    return {
      reason: lease.stopped
        ? 'the claim on this row was released and nothing has taken it since'
        : 'the claim on this row ran past its own expiry, and has been released',
      owes: fallbackOwner,
    };
  }
  if (lease.verdict === 'shared') {
    return {
      reason: `the lease holder id is on ${lease.fanout} issues at once, which is not evidence that a run is on this one`,
      owes: fallbackOwner,
    };
  }
  if (lease.verdict === 'malformed') {
    return {
      reason: `the lease on this row could not be read (${lease.detail}), so it is evidence of nothing and has been left standing`,
      owes: 'human',
    };
  }

  if (evidence.everRan && !evidence.merged) {
    return {
      reason: 'a run reached this issue and nothing carries it on: no merge mark, and no live run',
      owes: fallbackOwner,
    };
  }
  if (evidence.everRan && evidence.merged) {
    return {
      reason: 'the code carries a merge mark and nothing has moved the row since',
      owes: fallbackOwner,
    };
  }

  return {
    reason: 'no live work observed; what it waits for is not decidable from here',
    owes: fallbackOwner,
  };
}
