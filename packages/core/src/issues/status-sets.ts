import type { IssueStatus } from '../db/schema.js';

/**
 * The named answers about `issueStatuses`. One question has one answer: a
 * caller asks by importing the name, never by writing the tuple again.
 */

/** The issue is over. Nothing further will be done on it, whichever exit it took. */
export const ISSUE_TERMINAL_STATUSES: readonly IssueStatus[] = ['closed', 'dropped'];

/** The issue is stopped until a person acts: what Needs you and the park view both count (ISS-1310). */
export const AWAITING_INPUT_STATUSES: readonly IssueStatus[] = ['waiting', 'needs_info'];

/** A person parked the issue here, which outranks any automatic restore. */
export const HUMAN_PARK_STATUSES: readonly IssueStatus[] = ['needs_info', 'waiting', 'on_hold'];

/** The issue claims a run is working it right now. */
export const ASSERTS_WORK_IN_PROGRESS: readonly IssueStatus[] = [
  'in_progress',
  'testing',
  'releasing',
];

/** The issue has nothing left to do: a job that failed against it no longer matters. */
export const ISSUE_RESOLVED_STATUSES: readonly IssueStatus[] = ['awaiting_release', 'closed'];

/** Each status in a person's words: contracts' map, which core cannot import at runtime; held equal by a parity test. */
export const ISSUE_STATUS_LABELS: Readonly<Record<IssueStatus, string>> = {
  open: 'Open',
  confirmed: 'Confirmed',
  clarified: 'Clarified',
  waiting: 'Waiting',
  approved: 'Approved',
  in_progress: 'In progress',
  developed: 'Developed',
  testing: 'Testing',
  tested: 'Tested',
  awaiting_release: 'Awaiting release',
  releasing: 'Releasing',
  closed: 'Closed',
  reopen: 'Reopened',
  on_hold: 'On hold',
  needs_info: 'Needs info',
  draft: 'Draft',
  dropped: 'Dropped',
};
