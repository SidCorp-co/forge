import type { NotificationType } from '../db/schema.js';

export const notificationKinds = ['signal', 'condition', 'task'] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const notificationTiers = ['page', 'ticket', 'log'] as const;
export type NotificationTier = (typeof notificationTiers)[number];

/**
 * The states a record may hold, per kind. A `signal` cannot be resolved because an event
 * cannot stop having happened; a `condition` is resolved by the system re-evaluating it
 * and never by a person; a `task` does not self-clear and closes when the work is done.
 */
export const STATES_BY_KIND: Record<NotificationKind, readonly string[]> = {
  signal: ['emitted', 'expired'],
  condition: ['pending', 'firing', 'inhibited', 'resolved'],
  task: ['open', 'acknowledged', 'done', 'dismissed'],
};

/** The state a newly written record of each kind starts in. */
export const INITIAL_STATE: Record<NotificationKind, string> = {
  signal: 'emitted',
  condition: 'firing',
  task: 'open',
};

export interface NotificationKindEntry {
  kind: NotificationKind;
  tier: NotificationTier;
  /** Prometheus's `for`, counted in evaluations of a PERIODIC detector. */
  pendingEvaluations?: number;
}

export const NOTIFICATION_KIND_TABLE: Record<NotificationType, NotificationKindEntry> = {
  issue_status_changed: { kind: 'signal', tier: 'log' },
  mention: { kind: 'signal', tier: 'ticket' },
  pm_escalation: { kind: 'task', tier: 'page' },
  pipeline_wedge: { kind: 'condition', tier: 'page' },
  invitation_received: { kind: 'task', tier: 'ticket' },
  intake_pending: { kind: 'task', tier: 'ticket' },
  schedule_report: { kind: 'signal', tier: 'log' },
  reconcile_gate_pending: { kind: 'task', tier: 'ticket' },
  issue_stranded: { kind: 'condition', tier: 'ticket', pendingEvaluations: 2 },
  retry_rescue_threshold: { kind: 'condition', tier: 'ticket', pendingEvaluations: 2 },
  ops_alert: { kind: 'condition', tier: 'ticket' },
};

export function kindOf(type: NotificationType): NotificationKind {
  return NOTIFICATION_KIND_TABLE[type].kind;
}

export function tierOf(type: NotificationType): NotificationTier {
  return NOTIFICATION_KIND_TABLE[type].tier;
}

/** How many periodic evaluations a condition of this type must survive before delivery. */
export function pendingEvaluationsFor(type: NotificationType): number {
  return NOTIFICATION_KIND_TABLE[type].pendingEvaluations ?? 0;
}

export interface InhibitRule {
  source: NotificationType;
  target: NotificationType;
  scope: 'project';
}

export const INHIBIT_RULES: readonly InhibitRule[] = [
  { source: 'pipeline_wedge', target: 'issue_stranded', scope: 'project' },
];

/** The types whose firing suppresses `target`, or none. */
export function inhibitorsOf(target: NotificationType): NotificationType[] {
  return INHIBIT_RULES.filter((r) => r.target === target).map((r) => r.source);
}
