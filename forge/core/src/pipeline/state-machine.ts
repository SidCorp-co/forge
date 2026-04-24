import { type IssueStatus, issueStatuses } from '../db/schema.js';

export { issueStatuses };
export type { IssueStatus };

// Per docs/modules/issues-pipeline/status-pipeline.md. Each key lists allowed
// NEXT statuses from that state. on_hold is a pause state — it may resume to
// any other status (operator discretion). needs_info bounces back through
// triage.
export const transitions: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['confirmed', 'needs_info', 'on_hold'],
  confirmed: ['waiting', 'approved', 'needs_info', 'on_hold'],
  waiting: ['approved', 'confirmed', 'on_hold'],
  approved: ['in_progress', 'on_hold'],
  in_progress: ['developed', 'deploying', 'reopen', 'on_hold'],
  developed: ['deploying', 'reopen', 'on_hold'],
  deploying: ['testing', 'reopen', 'on_hold'],
  testing: ['tested', 'pass', 'reopen', 'on_hold'],
  tested: ['pass', 'reopen', 'on_hold'],
  pass: ['staging', 'reopen', 'on_hold'],
  staging: ['released', 'reopen', 'on_hold'],
  released: ['closed', 'on_hold'],
  closed: ['reopen'],
  reopen: ['developed', 'deploying', 'in_progress', 'on_hold'],
  on_hold: issueStatuses.filter((s) => s !== 'on_hold'),
  needs_info: ['open', 'confirmed', 'on_hold'],
};

export function getAllowedTransitions(from: IssueStatus): readonly IssueStatus[] {
  return transitions[from];
}

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return transitions[from].includes(to);
}

export const REOPEN_CAP = 5;

export function isReopenEntry(from: IssueStatus, to: IssueStatus): boolean {
  return from === 'closed' && to === 'reopen';
}
