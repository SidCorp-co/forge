export const NOTIFICATION_TYPES = [
  'issue_status_changed',
  'mention',
  'pm_escalation',
  'pipeline_wedge',
  'invitation_received',
  'intake_pending',
  'schedule_report',
  'reconcile_gate_pending',
  'issue_stranded',
  'retry_rescue_threshold',
  'ops_alert',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_KINDS = ['signal', 'condition', 'task'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_TIERS = ['page', 'ticket', 'log'] as const;
export type NotificationTier = (typeof NOTIFICATION_TIERS)[number];

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';
export type NotificationChannel = 'bell' | 'toast' | 'browser';

export interface NotificationTypeContract {
  /** Default severity; an emitter MAY override per-event (e.g.
   *  `issue_status_changed` derives severity from the `to` status). */
  severity: NotificationSeverity;
  /** Surfaces this type targets. `bell` is implied for every persisted type. */
  channels: NotificationChannel[];
  /** ISS-1063 — the record kind, declared ONCE. A type that is sometimes an event and
   *  sometimes a condition is the defect this field closes: 1771 `issue_status_changed`
   *  rows carried a condition's resolution key while the type is an event. */
  kind: NotificationKind;
  /** ISS-1063 — urgency, not routing. `channels` still decides which surfaces it reaches. */
  tier: NotificationTier;
  pendingEvaluations?: number;
}

/**
 * The channel matrix (ISS-510). Browser is reserved for high-signal types so
 * the OS surface stays quiet; everything is still recorded in the bell.
 */
export const NOTIFICATION_CONTRACT: Record<NotificationType, NotificationTypeContract> = {
  issue_status_changed: {
    severity: 'info',
    channels: ['bell', 'toast'],
    kind: 'signal',
    tier: 'log',
  },
  mention: {
    severity: 'info',
    channels: ['bell', 'toast', 'browser'],
    kind: 'signal',
    tier: 'ticket',
  },
  pm_escalation: {
    severity: 'warning',
    channels: ['bell', 'toast', 'browser'],
    kind: 'task',
    tier: 'page',
  },
  pipeline_wedge: {
    severity: 'error',
    channels: ['bell', 'toast', 'browser'],
    kind: 'condition',
    tier: 'page',
  },
  invitation_received: {
    severity: 'warning',
    channels: ['bell', 'toast'],
    kind: 'task',
    tier: 'ticket',
  },
  intake_pending: {
    severity: 'info',
    channels: ['bell', 'toast'],
    kind: 'task',
    tier: 'ticket',
  },
  schedule_report: {
    severity: 'info',
    channels: ['bell', 'toast'],
    kind: 'signal',
    tier: 'log',
  },
  reconcile_gate_pending: {
    severity: 'warning',
    channels: ['bell', 'toast'],
    kind: 'task',
    tier: 'ticket',
  },
  issue_stranded: {
    severity: 'warning',
    channels: ['bell', 'toast', 'browser'],
    kind: 'condition',
    tier: 'ticket',
    pendingEvaluations: 2,
  },
  retry_rescue_threshold: {
    severity: 'warning',
    channels: ['bell', 'toast', 'browser'],
    kind: 'condition',
    tier: 'ticket',
    pendingEvaluations: 2,
  },
  ops_alert: {
    severity: 'warning',
    channels: ['bell', 'toast'],
    kind: 'condition',
    tier: 'ticket',
  },
};

export interface NotificationInhibitRule {
  /** The firing type that suppresses. */
  source: NotificationType;
  /** The type that is suppressed while it does. */
  target: NotificationType;
  /**
   * What the two must share for the rule to apply. `project` is the only scope this
   * change needs: a wedge naming a project's runner pool suppresses that project's
   * stranded parks, because the parks are what the wedge is causing.
   */
  scope: 'project';
}

export const INHIBIT_RULES: readonly NotificationInhibitRule[] = [
  { source: 'pipeline_wedge', target: 'issue_stranded', scope: 'project' },
];

/** Channels a type targets; defaults to bell-only for an unknown/legacy type. */
export function channelsFor(type: string): NotificationChannel[] {
  return NOTIFICATION_CONTRACT[type as NotificationType]?.channels ?? ['bell'];
}

/** Contract default severity; `info` for an unknown/legacy type. */
export function defaultSeverityForType(type: string): NotificationSeverity {
  return NOTIFICATION_CONTRACT[type as NotificationType]?.severity ?? 'info';
}

/** Whether a type targets a given delivery channel. */
export function targetsChannel(type: string, channel: NotificationChannel): boolean {
  return channelsFor(type).includes(channel);
}
