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
