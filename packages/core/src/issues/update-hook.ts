import { diffFieldValue } from '@forge/contracts/field-changes';
import type { Tx } from '../db/client.js';
import { emitEvent } from '../outbox/index.js';
import type { Actor } from './activity.js';

type IssueFields = { id: string; projectId: string } & Record<string, unknown>;

/**
 * Write the `issue.updated` event for the fields a write moved, read off the row before and the row
 * after, on the write's own transaction. A write that moved nothing emits nothing.
 */
export async function emitIssueFieldUpdate(
  tx: Tx,
  input: { before: IssueFields; after: IssueFields; written: readonly string[]; actor: Actor },
): Promise<void> {
  const fields: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of input.written) {
    const prev = input.before[field];
    const next = input.after[field];
    if (diffFieldValue(field, prev, next).length === 0) continue;
    fields.push(field);
    before[field] = prev;
    after[field] = next;
  }
  if (fields.length === 0) return;
  await emitEvent(tx, 'issue.updated', {
    issueId: input.after.id,
    projectId: input.after.projectId,
    actor: input.actor,
    fields,
    before,
    after,
  });
}
