import { type NotificationType, defaultSeverityForType } from '@forge/contracts';
import { createNotification } from './routes.js';

/**
 * The single emission path for notifications (ISS-510).
 *
 * Every producer (`notify-transitions`, `notify-mentions`,
 * `forge-pm-write-decision`, …) routes through here instead of hand-building a
 * `notifications` row, so severity + channel semantics stay consistent with the
 * `@forge/contracts` notification contract. When the caller does not pass an
 * explicit `severity` (e.g. `issue_status_changed`, whose severity depends on
 * the target status) it defaults to the contract severity for the type.
 *
 * Thin wrapper over {@link createNotification}: the mention delivery-preference
 * gate, the row insert, and the `notificationCreated` hook all still live there.
 */
export interface EmitNotificationInput {
  userId: string;
  projectId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  issueId?: string | null;
  agentSessionId?: string | null;
  /** Overrides the contract default severity for this single event. */
  severity?: string | null;
  /** Stable per-condition key so a later resolver can auto-clear this row. */
  resolutionKey?: string | null;
  /** Set for `pm_escalation` — forwarded to the project-room WS bridge. */
  decisionId?: string | null;
}

export async function emitNotification(
  input: EmitNotificationInput,
): Promise<{ id: string } | null> {
  return createNotification({
    ...input,
    severity: input.severity ?? defaultSeverityForType(input.type),
  });
}
