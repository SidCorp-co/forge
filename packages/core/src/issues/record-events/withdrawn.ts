// What a withdrawal leaves on the records it names (ISS-585): a withdrawn record is kept, never
// deleted, and every read of standing records leaves it out by this one condition.

import { recordAction } from '@forge/contracts/record-events';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { activityLog } from '../../db/schema-activity.js';

/** A withdrawal as the record it withdrew carries it. */
export interface RecordWithdrawn {
  readonly eventId: string;
  readonly at: Date;
  readonly by: { readonly type: string; readonly id: string };
  readonly reason: string;
}

/** The action a withdrawal is stored under, and the payload key naming the record it withdrew. */
export const WITHDRAWAL_ACTION = recordAction('withdrawal');
export const WITHDRAWS_KEY = 'withdraws';

/**
 * True of an `activity_log` row no withdrawal names: the condition every read of standing records
 * adds, so a withdrawn decision stops answering anything wherever it is read.
 */
export const notWithdrawnSql = sql`NOT EXISTS (
  SELECT 1 FROM activity_log w
  WHERE w.issue_id = ${activityLog.issueId}
    AND w.action = ${WITHDRAWAL_ACTION}
    AND w.payload->>${WITHDRAWS_KEY} = ${activityLog.id}::text
)`;

const reasonOf = (fields: unknown): string => {
  if (!Array.isArray(fields)) return '';
  const hit = fields.find((f) => f?.key === 'reason' && typeof f.value === 'string');
  return typeof hit?.value === 'string' ? hit.value : '';
};

/** The withdrawal of each record on this issue that was withdrawn, keyed by the record's id. */
export async function withdrawalsOn(
  issueId: string,
  executor: Tx = db,
): Promise<Map<string, RecordWithdrawn>> {
  const rows = await executor
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.issueId, issueId), eq(activityLog.action, WITHDRAWAL_ACTION)));
  const out = new Map<string, RecordWithdrawn>();
  for (const row of rows) {
    const payload = (row.payload ?? {}) as { withdraws?: unknown; fields?: unknown };
    if (typeof payload.withdraws !== 'string') continue;
    out.set(payload.withdraws, {
      eventId: row.id,
      at: row.createdAt,
      by: { type: row.actorType, id: row.actorId },
      reason: reasonOf(payload.fields),
    });
  }
  return out;
}
