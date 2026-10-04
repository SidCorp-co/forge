import type { IssueStatus } from '../db/schema.js';

/**
 * The named answers about `issueStatuses`. One question has one answer: a
 * caller asks by importing the name, never by writing the tuple again.
 */

/** The issue is over. Nothing further will be done on it, whichever exit it took. */
export const ISSUE_TERMINAL_STATUSES: readonly IssueStatus[] = ['closed', 'dropped'];

/**
 * The statuses a master may start work from: what `forge next` ranks (forge-plugin
 * `rank/weights.mjs:TAKEABLE`), what the backlog stream orders, and what the admissible list hands a
 * box. One answer, so a reopened issue is never eligible on one read and absent on the other. The
 * backlog, the plan checkpoint a run resumes at build, and a reopen (workflow `issue-lifecycle`).
 */
export const TAKEABLE_STATUSES: readonly IssueStatus[] = ['open', 'approved', 'reopen'];

/** The issue is stopped until a person answers: what Needs you and the park view both count (ISS-1310). */
export const AWAITING_INPUT_STATUSES: readonly IssueStatus[] = ['needs_info'];

/** The issue claims a run is working it right now; its step is on `issue_work_state`. */
export const ASSERTS_WORK_IN_PROGRESS: readonly IssueStatus[] = ['in_progress'];

/** The issue has nothing left to do: a job that failed against it no longer matters. */
export const ISSUE_RESOLVED_STATUSES: readonly IssueStatus[] = ['awaiting_release', 'closed'];

/** The issue is not counted as open work in a project's totals. */
export const NON_OPEN_STATUSES: readonly IssueStatus[] = [
  'awaiting_release',
  'closed',
  'draft',
  'dropped',
];

/** Each status in a person's words: contracts' map, which core cannot import at runtime; held equal by a parity test. */
export const ISSUE_STATUS_LABELS: Readonly<Record<IssueStatus, string>> = {
  draft: 'Draft',
  open: 'Open',
  reopen: 'Reopened',
  in_progress: 'In progress',
  approved: 'Approved',
  needs_info: 'Needs info',
  on_hold: 'On hold',
  awaiting_release: 'Awaiting release',
  closed: 'Closed',
  dropped: 'Dropped',
};
