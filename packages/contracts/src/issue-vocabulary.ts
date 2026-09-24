import type { REGISTRY_ISSUE_STATUSES } from './pipeline-registry.js';

export type KernelIssueStatus = (typeof REGISTRY_ISSUE_STATUSES)[number];

export const AUTONOMOUS_LABELS = [
  'draft',
  'open',
  'running',
  'stalled',
  'needs_human',
  'paused',
  'awaiting_release',
  'reopened',
  'done',
  'dropped',
] as const;

export type AutonomousLabel = (typeof AUTONOMOUS_LABELS)[number];

/** Every label but `stalled`, which is read off a row that nothing holds and is never written. */
export type WritableLabel = Exclude<AutonomousLabel, 'stalled'>;

/** The kernel status a label is written as. */
export const LABEL_TO_KERNEL: Record<WritableLabel, KernelIssueStatus> = {
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

/** `running` is only a held row's word; `toAutonomousLabel` reads the same status `stalled` unheld. */
const KERNEL_TO_LABEL: Record<KernelIssueStatus, WritableLabel> = {
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

/** `held` (the search row's own) is required: a status alone cannot say whether a run is behind it. */
export function toAutonomousLabel(status: KernelIssueStatus, held: boolean): AutonomousLabel {
  const label = KERNEL_TO_LABEL[status];
  return label === 'running' && !held ? 'stalled' : label;
}

/**
 * The statuses that can read one of these labels, held or not: a status filter cannot see the
 * holder. There is one lane and therefore one vocabulary — a project does not choose it.
 */
export function statusesForLabels(...labels: AutonomousLabel[]): KernelIssueStatus[] {
  return (Object.keys(KERNEL_TO_LABEL) as KernelIssueStatus[]).filter(
    (s) => labels.includes(toAutonomousLabel(s, true)) || labels.includes(toAutonomousLabel(s, false)),
  );
}
