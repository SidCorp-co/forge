import type { REGISTRY_ISSUE_STATUSES } from './pipeline-registry.js';

export type KernelIssueStatus = (typeof REGISTRY_ISSUE_STATUSES)[number];

export const AUTONOMOUS_LABELS = [
  'draft',
  'open',
  'running',
  'needs_human',
  'paused',
  'awaiting_release',
  'reopened',
  'done',
  'dropped',
] as const;

export type AutonomousLabel = (typeof AUTONOMOUS_LABELS)[number];

/** The kernel status a label is written as. */
export const LABEL_TO_KERNEL: Record<AutonomousLabel, KernelIssueStatus> = {
  draft: 'draft',
  open: 'open',
  running: 'in_progress',
  needs_human: 'needs_info',
  paused: 'on_hold',
  awaiting_release: 'awaiting_release',
  reopened: 'reopen',
  done: 'closed',
  dropped: 'dropped',
};

const KERNEL_TO_LABEL: Record<KernelIssueStatus, AutonomousLabel> = {
  draft: 'draft',
  open: 'open',
  confirmed: 'running',
  clarified: 'running',
  approved: 'running',
  in_progress: 'running',
  developed: 'running',
  testing: 'running',
  tested: 'awaiting_release',
  awaiting_release: 'awaiting_release',
  releasing: 'running',
  reopen: 'reopened',
  waiting: 'needs_human',
  on_hold: 'paused',
  needs_info: 'needs_human',
  closed: 'done',
  dropped: 'dropped',
};

export function toAutonomousLabel(status: KernelIssueStatus): AutonomousLabel {
  return KERNEL_TO_LABEL[status];
}

/**
 * How to render an issue's status. There is one lane and therefore one
 * vocabulary — a project does not choose it.
 */
export function statusesForLabels(...labels: AutonomousLabel[]): KernelIssueStatus[] {
  return (Object.keys(KERNEL_TO_LABEL) as KernelIssueStatus[]).filter((s) =>
    labels.includes(toAutonomousLabel(s)),
  );
}
