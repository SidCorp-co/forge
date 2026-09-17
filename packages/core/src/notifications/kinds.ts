/**
 * ISS-1063 — core's runtime copy of the notification taxonomy: what KIND of record each
 * type is, how urgent it is, how many evaluations a condition must survive before anyone
 * is told, and which firing type suppresses which.
 *
 * WHY THIS IS A COPY AND NOT AN IMPORT. `@forge/contracts` is a TYPE-ONLY surface in
 * core's production runtime image and is not present in it; importing a runtime VALUE
 * from there crashed boot with `ERR_MODULE_NOT_FOUND` (ISS-510), which is why
 * `notifications/emit.ts` already carries its own inlined severity table for the same
 * reason. The duplication is deliberate and it is held honest by a test rather than by
 * this comment.
 */

// cm:edge lockstep -> packages/contracts/src/notifications.ts — NOTIFICATION_CONTRACT carries the same kind, tier and pending duration for every type, and `kinds.test.ts` fails on any disagreement between the two and `db/schema.ts`'s column. Three copies, one meaning: change any of them alone and that test names which pair drifted.
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
