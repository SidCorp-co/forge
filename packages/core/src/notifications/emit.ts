import { defaultSeverityForType } from '@forge/contracts/notifications';
import type { Tx } from '../db/client.js';
import { type NotificationType, notifications } from '../db/schema.js';
import { recordAndDeliver } from './deliver.js';
import { INITIAL_STATE, kindOf, tierOf } from './kinds.js';

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

/**
 * One notification record written in the caller's transaction, for an act that raises it as part
 * of its own write; the caller delivers it once the transaction committed.
 */
async function insertNotificationRecord(
  tx: Tx,
  values: typeof notifications.$inferInsert,
): Promise<string | null> {
  const [record] = await tx
    .insert(notifications)
    .values(values)
    .returning({ id: notifications.id });
  return record?.id ?? null;
}

/**
 * One record of `type` written in the caller's transaction, its kind, tier and state derived from
 * the type. The caller delivers it once the transaction committed.
 */
export async function insertTypedNotificationRecord(
  tx: Tx,
  input: {
    projectId: string;
    type: NotificationType;
    title: string;
    body: string;
    issueId: string | null;
    agentSessionId: string | null;
  },
): Promise<string | null> {
  const kind = kindOf(input.type);
  return insertNotificationRecord(tx, {
    ...input,
    kind,
    tier: tierOf(input.type),
    state: INITIAL_STATE[kind],
  });
}
