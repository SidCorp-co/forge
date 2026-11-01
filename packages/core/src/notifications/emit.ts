import { notificationContractOf } from '@forge/contracts/notifications';
import type { NotificationType } from '../db/schema.js';
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
  /** The stored status report a `status_report` notice links to. */
  statusReportId?: string | null;
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

/**
 * Where an emitter names no group, the item it is about does (ISS-863: repeats per item collapse
 * into one): every record of one type on one issue reaches a reader as one delivery, read again as
 * new when a repeat lands after it was read. A record about no issue stands alone.
 */
const itemGroupOf = (input: EmitNotificationInput): string | null =>
  input.issueId ? `item:${input.type}:${input.issueId}` : null;

/** The one write entry: a record of `type` at its contract severity unless overridden, delivered. */
export async function emitNotification(
  input: EmitNotificationInput,
): Promise<{ id: string; delivered: number }> {
  return recordAndDeliver({
    ...input,
    groupKey: input.groupKey ?? itemGroupOf(input),
    recipients: input.recipients ?? (input.userId ? [input.userId] : []),
    severity: input.severity ?? notificationContractOf(input.type).severity,
  });
}
