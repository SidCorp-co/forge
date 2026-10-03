import { diffFieldValue } from '@forge/contracts/field-changes';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import type { IssueRow } from './read-service.js';

/**
 * Emit `issueUpdated` for the fields a write moved, read off the row before and the row after, so
 * the activity log, the WS room and the memory index hear of an MCP write exactly as of a REST one.
 * A write that moved nothing emits nothing.
 */
export async function emitIssueFieldUpdate(input: {
  before: IssueRow;
  after: IssueRow;
  written: readonly string[];
  actor: Actor;
}): Promise<void> {
  const fields: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of input.written) {
    const prev = input.before[field as keyof IssueRow];
    const next = input.after[field as keyof IssueRow];
    if (diffFieldValue(field, prev, next).length === 0) continue;
    fields.push(field);
    before[field] = prev;
    after[field] = next;
  }
  if (fields.length === 0) return;
  await hooks.emit('issueUpdated', {
    issueId: input.after.id,
    projectId: input.after.projectId,
    actor: input.actor,
    fields,
    before,
    after,
  });
}
