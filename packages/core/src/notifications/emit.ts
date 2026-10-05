import { defaultSeverityForType } from '@forge/contracts/notifications';
import { type NotificationType } from '../db/schema.js';
import { recordAndDeliver } from './deliver.js';

interface EmitNotificationInput {
  userId?: string;
  recipients?: string[];
  projectId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  issueId?: string | null;
  secondaryIssueId?: string | null;
  agentSessionId?: string | null;
  scheduleRunId?: string | null;
  /** Overrides the contract default severity for this single event. */
  severity?: string | null;
  /** Stable per-condition key so a later resolver can auto-clear this row. */
  resolutionKey?: string | null;
  /** ISS-849 — redelivery-dedup key, e.g. `transition:<outboxId>`. */
  dedupeKey?: string | null;
  /** ISS-1063 — records raised by one evaluation reach a reader as one delivery. */
  groupKey?: string | null;
  /** What that one delivery is called. */
  groupTitle?: string | null;
}

/** The one write entry: a record of `type` at its contract severity unless overridden, delivered. */
export async function emitNotification(
  input: EmitNotificationInput,
): Promise<{ id: string; delivered: number }> {
  return recordAndDeliver({
    ...input,
    recipients: input.recipients ?? (input.userId ? [input.userId] : []),
    severity: input.severity ?? defaultSeverityForType(input.type),
  });
}
