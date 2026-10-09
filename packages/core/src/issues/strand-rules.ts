/**
 * Which non-terminal statuses are watched for a stranded row, on what clock, and who owes the next
 * move. A `Record<IssueStatus, StrandRule>`, so an unclassified new status is a typecheck failure
 * rather than a row falling out of the sweep — the hole ISS-1122 was filed about.
 */

import { TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import type { ReleaseHoldView } from '@forge/contracts/releases';
import { say, sayEn } from '@forge/contracts/said';
import type { WaitingSays } from '@forge/contracts/standing';
import type { IssueStatus } from '../db/schema.js';
import type { WorkStep } from '../db/schema-issue-work-state.js';
import type { LeaseReading } from './session-claim.js';

type ReleaseHold = Omit<ReleaseHoldView, 'heldAt'>;

/**
 * Whose move it is for a stranded row to leave the status it is stuck at. `blocker` is what
 * withholds a takeable row from dispatch — a holding `blocks` edge, an unapproved design, an
 * unsettled contract wait — whose own work moves it, never this row's.
 */
type StrandOwner = 'agent' | 'human' | 'blocker';

type StrandRule =
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
  on_hold: { watch: false, atRest: 'a deliberate pause, whose reason the row already carries' },
  needs_info: {
    watch: false,
    atRest:
      'the status names what it waits for: a person owes an answer (a park over merged code is detectStrandedIssues in stranded-issues.ts)',
  },
  closed: { watch: false, atRest: 'terminal: the work is over and nothing is owed' },
  dropped: { watch: false, atRest: 'terminal: the work was abandoned and nothing is owed' },

  open: {
    watch: true,
    graceMs: 15 * MINUTE,
    owes: 'agent',
    waitingFor: 'a run to be dispatched onto it',
  },
  approved: { watch: true, graceMs: 6 * HOUR, owes: 'agent', waitingFor: 'a run to build it' },
  in_progress: {
    watch: true,
    graceMs: 2 * HOUR,
    owes: 'agent',
    waitingFor: 'the run that claimed it',
  },
  awaiting_release: {
    watch: true,
    graceMs: 48 * HOUR,
    owes: 'human',
    waitingFor: 'a person to release it',
  },
  reopen: { watch: true, graceMs: 6 * HOUR, owes: 'agent', waitingFor: 'a run to build it again' },
};
const WATCHED_STATUSES: readonly IssueStatus[] = (
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

function silence(lease: LeaseReading): string {
  const minutes = Math.floor((lease.silentMs ?? 0) / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 120) return `${minutes} minute(s) ago`;
  return `${Math.floor(minutes / 60)} hour(s) ago`;
}

/** What the pass could see about one row, and nothing it inferred. */
export interface StrandEvidence {
  merged: boolean;
  /** Whether any `pipeline_runs` row has ever existed for this issue, terminal or not. */
  everRan: boolean;
  /** Whether this project has a runner admitted to the job pool. */
  poolHasRunner: boolean;
  lease: LeaseReading;
  /** The automatic release's standing hold on the row, why it is not taking it (ISS-1215). */
  releaseHold?: ReleaseHold | null;
  step?: WorkStep | null;
  /** What withholds a takeable row from dispatch, read by the admissible list's own predicates. */
  withheld?: StrandWithheld | null;
}

/** The gates the admissible list withholds a takeable row behind, as the sweep read them. */
export interface StrandWithheld {
  /** Keys of the blockers whose live `blocks` edge holds it (`blocked-by.ts:blockerUnsettledSql`). */
  blockers: readonly string[];
  /** It builds a workflow whose design is not approved (`designUnapprovedSql`). */
  design: boolean;
  /** It waits on a contract version no approved version settles (`contractWaitUnsettledSql`). */
  contract: boolean;
  /** It names a new pattern that waits on its reviewer (`patternReviewPendingSql`). */
  pattern: boolean;
}

/**
 * A takeable row the admissible list withholds is waiting on what withholds it, not on a dispatch:
 * no master is handed it, so "the dispatch did not happen" would name a cause that is not there
 * (hop ISS-72..76, each held by a `blocks` edge from an open ISS-71).
 */
export function withheldWait(
  status: string,
  withheld: StrandWithheld | null | undefined,
): { waitingFor: string; owes: StrandOwner; reason: string } | null {
  if (!withheld || !(TAKEABLE_STATUSES as readonly string[]).includes(status)) return null;
  const { blockers, design, contract, pattern } = withheld;
  if (blockers.length > 0) {
    const named = blockers.join(', ');
    const edges = blockers.length === 1 ? 'a live `blocks` edge' : 'live `blocks` edges';
    return {
      waitingFor: `${named} to settle (${edges} hold it)`,
      owes: 'blocker',
      reason: `${edges} from ${named} hold it, so no run is handed it until ${blockers.length === 1 ? 'that blocker settles' : 'those blockers settle'}: it is waiting on ${blockers.length === 1 ? 'its blocker' : 'its blockers'}, not on a dispatch`,
    };
  }
  if (design) {
    return {
      waitingFor: 'the design of the workflow it builds to be approved',
      owes: 'blocker',
      reason:
        'it builds a workflow whose design is not approved, so no run is handed it until a revision is approved: it is waiting on that approval, not on a dispatch',
    };
  }
  if (contract) {
    return {
      waitingFor: 'an approved contract version that settles its wait',
      owes: 'blocker',
      reason:
        'it waits on a contract version no approved version settles, so no run is handed it until one is approved: it is waiting on that contract, not on a dispatch',
    };
  }
  if (pattern) {
    return {
      waitingFor: 'one reviewer to decide the new pattern it names',
      owes: 'blocker',
      reason:
        'it names a new pattern no reviewer has decided, so no run is handed it until a holder of patterns.approve approves or returns it: it is waiting on that review, not on a dispatch',
    };
  }
  return null;
}

/** Who a held `awaiting_release` row waits on: the automatic release's hold outranks the rule. */
export function heldReleaseWait(
  status: string,
  hold: ReleaseHold | null | undefined,
): { waitingFor: string; owes: StrandOwner; reason: string } | null {
  if (status !== 'awaiting_release' || !hold) return null;
  return {
    waitingFor: hold.waitingFor,
    owes: hold.owes,
    reason: `the automatic release is holding it (${hold.code}): ${hold.reason}`,
  };
}

// a recorded landing moves no status (issue-lifecycle rev 8), so a landed row a run may take waits on
// the run that claims it and judges what landed, never on the expired claim of the run that landed
// it. The sweep's reason and the board's standing (`issues/standing.ts`) both read it here.
export function landedWait(
  status: string,
  evidence: Pick<StrandEvidence, 'merged' | 'step'>,
): { waitingFor: string; owes: StrandOwner; reason: string; says: WaitingSays } | null {
  if (!evidence.merged) return null;
  if (status === 'open' || status === 'approved' || status === 'reopen') {
    const rule = say('issues.rule.landed', { status });
    return {
      waitingFor: 'a run to claim it and judge what landed',
      owes: 'agent',
      reason: sayEn(rule),
      says: {
        who: say('issues.standing.who.nextRun'),
        act: say('issues.standing.act.landedClaim'),
        rule,
      },
    };
  }
  return null;
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
  const lease = evidence.lease;

  const held = heldReleaseWait(status, evidence.releaseHold);
  if (held) return { reason: held.reason, owes: held.owes };
  const landed = landedWait(status, evidence);
  if (landed) return { reason: landed.reason, owes: landed.owes };

  // Ahead of the status-keyed answers below, alone among the readings: it measures the holder.
  if (lease.verdict === 'abandoned') {
    return {
      reason: `the lease has not run out, and its holder stopped reporting ${silence(lease)} against a heartbeat it declared, so it has been released`,
      owes: fallbackOwner,
    };
  }

  const withheld = withheldWait(status, evidence.withheld);
  if (withheld) return { reason: withheld.reason, owes: withheld.owes };

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
