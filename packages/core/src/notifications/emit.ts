import type { NotificationType } from '../db/schema.js';
import { createNotification } from './routes.js';

const DEFAULT_SEVERITY_BY_TYPE: Record<NotificationType, string> = {
  issue_status_changed: 'info',
  mention: 'info',
  pm_escalation: 'warning',
  pipeline_wedge: 'error',
  invitation_received: 'warning',
  intake_pending: 'info',
  schedule_report: 'info',
  reconcile_gate_pending: 'warning',
  issue_stranded: 'warning',
  retry_rescue_threshold: 'warning',
  ops_alert: 'warning',
};

function defaultSeverityForType(type: NotificationType): string {
  return DEFAULT_SEVERITY_BY_TYPE[type] ?? 'info';
}

export interface EmitNotificationInput {
  userId?: string;
  recipients?: string[];
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
  /** ISS-849 — redelivery-dedup key, e.g. `transition:<outboxId>`. */
  dedupeKey?: string | null;
  /** Set for `pm_escalation` — forwarded to the project-room WS bridge. */
  decisionId?: string | null;
  /** ISS-1063 — records raised by one evaluation reach a reader as one delivery. */
  groupKey?: string | null;
  /** What that one delivery is called. */
  groupTitle?: string | null;
}

export async function emitNotification(
  input: EmitNotificationInput,
): Promise<{ id: string; delivered: number } | null> {
  return createNotification({
    ...input,
    severity: input.severity ?? defaultSeverityForType(input.type),
  });
}
