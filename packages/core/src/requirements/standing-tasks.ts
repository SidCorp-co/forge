/**
 * The tasks a requirement's standing opens (workflow requirement-to-delivery): the master's breakdown
 * and re-plan tasks and the BA's acceptance check, each with its SLA read in working days.
 */

import {
  BREAKDOWN_SLA_WORKING_DAYS,
  CHECK_SLA_WORKING_DAYS,
  type RequirementTask,
} from '@forge/contracts/requirements';
import { addWorkingDays } from '../lib/working-days.js';
import type { Phased, StandingInput, StandingIssue } from './standing.js';

type SlaTask = Extract<RequirementTask, { kind: 'breakdown' | 'check' }>;
type ReplanTask = Extract<RequirementTask, { kind: 're-plan' }>;

const taskOf = (
  kind: SlaTask['kind'],
  owner: SlaTask['owner'],
  revision: number,
  openedAt: Date,
  days: number,
  now: Date,
): SlaTask => {
  const due = addWorkingDays(openedAt, days);
  return {
    kind,
    owner,
    revision,
    openedAt: openedAt.toISOString(),
    dueAt: due.toISOString(),
    overdue: now.getTime() > due.getTime(),
  };
};

// workflow requirement-to-delivery: `impact` opens one re-plan task in `delivery` per flagged issue and
// revision, the master's, for each live issue of an agreed requirement still to ship whose plan a
// later revision changed (changedSincePlan, the flag the awaiting_release gate refuses on); it opens
// when the revision it is for became current, and the design gives it no SLA
export function replanTasksOf(input: StandingInput, live: readonly StandingIssue[]): ReplanTask[] {
  const revision = input.currentRevision;
  if (input.status !== 'agreed' || revision === null) return [];
  const head = input.revisions.find((r) => r.revision === revision);
  const openedAt = (head?.decidedAt ?? head?.createdAt ?? input.updatedAt).toISOString();
  return live
    .filter((i) => i.changedSincePlan && i.status !== 'closed')
    .map((i) => ({
      kind: 're-plan',
      owner: 'Project master',
      revision,
      openedAt,
      dueAt: null,
      overdue: false,
      issueId: i.id,
      displayId: i.displayId,
    }));
}

// workflow requirement-to-delivery step `breakdown`: the project master proposes the breakdown of
// an agreed revision within 2 working days; the task is open while the revision has no live issue
// and no open breakdown suggestion
export function breakdownTaskOf(
  input: StandingInput,
  live: readonly StandingIssue[],
): SlaTask | null {
  if (input.status !== 'agreed' || input.currentRevision === null || !input.agreedAt) return null;
  if (live.length > 0 || input.openSuggestionKinds.includes('breakdown')) return null;
  return taskOf(
    'breakdown',
    'Project master',
    input.currentRevision,
    input.agreedAt,
    BREAKDOWN_SLA_WORKING_DAYS,
    input.now,
  );
}

// workflow requirement-to-delivery step `check`: a requirement delivered at its current revision holds
// one acceptance check for that revision, owned by the BA and due 5 working days after the evidence
// completed (the last live issue closed, or the newest passing traced verdict). `input.phase` is
// `deliveryOf`'s, so the task is read from the same computation as delivered
export function checkTaskOf(input: Phased, live: readonly StandingIssue[]): SlaTask | null {
  if (input.status !== 'agreed' || input.phase !== 'delivered') return null;
  if (input.currentRevision === null || live.length === 0) return null;
  const ids = new Set(live.map((i) => i.id));
  const times = [
    ...live.map((i) => i.closedAt ?? i.updatedAt),
    ...input.issueCriteria
      .filter((c) => ids.has(c.issueId) && c.verdict === 'pass')
      .flatMap((c) => (c.verdictAt ? [c.verdictAt] : [])),
  ];
  const openedAt = new Date(Math.max(...times.map((t) => t.getTime())));
  return taskOf('check', 'BA', input.currentRevision, openedAt, CHECK_SLA_WORKING_DAYS, input.now);
}

/** Every task the standing opens: the breakdown and the check where they are due, then each re-plan. */
export function tasksOf(input: Phased, live: readonly StandingIssue[]): RequirementTask[] {
  return [
    ...[breakdownTaskOf(input, live), checkTaskOf(input, live)].filter(
      (t): t is SlaTask => t !== null,
    ),
    ...replanTasksOf(input, live),
  ];
}
