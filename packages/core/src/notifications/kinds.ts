import {
  type NotificationKind,
  type NotificationTier,
  notificationContractOf,
} from '@forge/contracts/notifications';
import type { NotificationType } from '../db/schema.js';

/** The state a newly written record of each kind starts in. */
export const INITIAL_STATE: Record<NotificationKind, string> = {
  signal: 'emitted',
  condition: 'firing',
  task: 'open',
};

export function kindOf(type: NotificationType): NotificationKind {
  return notificationContractOf(type).kind;
}

export function tierOf(type: NotificationType): NotificationTier {
  return notificationContractOf(type).tier;
}

/** How many periodic evaluations a condition of this type must survive before delivery. */
export function pendingEvaluationsFor(type: NotificationType): number {
  return notificationContractOf(type).pendingEvaluations ?? 0;
}

interface InhibitRule {
  source: NotificationType;
  target: NotificationType;
  scope: 'project';
}

const INHIBIT_RULES: readonly InhibitRule[] = [
  { source: 'pipeline_wedge', target: 'issue_stranded', scope: 'project' },
];

/** The types whose firing suppresses `target`, or none. */
export function inhibitorsOf(target: NotificationType): NotificationType[] {
  return INHIBIT_RULES.filter((r) => r.target === target).map((r) => r.source);
}
