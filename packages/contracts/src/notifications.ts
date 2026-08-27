// Canonical notification taxonomy + per-type delivery contract (ISS-510).
//
// One source of truth shared by core emission and web-v2 rendering: every
// notification type declares its default `severity` and which of the three
// surfaces it targets —
//   • `bell`    — persistent in-app notification center (always on)
//   • `toast`   — transient on-screen toast/snackbar
//   • `browser` — native OS / Chrome notification (permission + opt-in gated)
//
// Core's `emitNotification` reads `defaultSeverityForType`; web-v2's realtime
// delivery bridge reads `channelsFor` to decide whether an incoming
// `notification.created` event pops a toast and/or a browser notification.

export const NOTIFICATION_TYPES = [
  'issue_status_changed',
  'comment_added',
  'agent_completed',
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

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';
export type NotificationChannel = 'bell' | 'toast' | 'browser';

export interface NotificationTypeContract {
  /** Default severity; an emitter MAY override per-event (e.g.
   *  `issue_status_changed` derives severity from the `to` status). */
  severity: NotificationSeverity;
  /** Surfaces this type targets. `bell` is implied for every persisted type. */
  channels: NotificationChannel[];
}

/**
 * The channel matrix (ISS-510). Browser is reserved for high-signal types so
 * the OS surface stays quiet; everything is still recorded in the bell.
 */
export const NOTIFICATION_CONTRACT: Record<NotificationType, NotificationTypeContract> = {
  issue_status_changed: { severity: 'info', channels: ['bell', 'toast'] },
  comment_added: { severity: 'info', channels: ['bell'] },
  agent_completed: { severity: 'success', channels: ['bell', 'toast'] },
  mention: { severity: 'info', channels: ['bell', 'toast', 'browser'] },
  pm_escalation: { severity: 'warning', channels: ['bell', 'toast', 'browser'] },
  pipeline_wedge: { severity: 'error', channels: ['bell', 'toast', 'browser'] },
  invitation_received: { severity: 'warning', channels: ['bell', 'toast'] },
  intake_pending: { severity: 'info', channels: ['bell', 'toast'] },
  schedule_report: { severity: 'info', channels: ['bell', 'toast'] },
  reconcile_gate_pending: { severity: 'warning', channels: ['bell', 'toast'] },
  // cm:why ISS-762 — browser-channel because this one is defined by nobody looking: the three known cases sat 7–12 days precisely because a bell nobody opened was the only surface. A type that fires only when a human already stopped watching has to reach past the app.
  issue_stranded: { severity: 'warning', channels: ['bell', 'toast', 'browser'] },
  retry_rescue_threshold: { severity: 'warning', channels: ['bell', 'toast', 'browser'] },
  // cm:why ISS-652 — browser channel deliberately omitted: an ops alert is checked by someone already watching the console, unlike issue_stranded (defined by nobody looking)
  ops_alert: { severity: 'warning', channels: ['bell', 'toast'] },
};

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
