import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { issueLabels, issues } from '../../db/schema.js';
import { recordActivityTx } from '../../pipeline/activity.js';

type IssueUpdateExecutor = Parameters<Parameters<Db['transaction']>[0]>[0];

type WriteIssueFieldsInput = {
  issueId: string;
  deviceId: string;
  updates: Record<string, unknown>;
  labelIds: string[] | undefined;
};

export async function writeIssueFields(
  executor: IssueUpdateExecutor,
  input: WriteIssueFieldsInput,
): Promise<void> {
  if (Object.keys(input.updates).length === 0 && input.labelIds === undefined) return;

  // cm:guard use sql`now()`, matching transitionIssueStatus — a combined status+fields update needs one canonical timestamp source, not a mix of JS Date and DB now()
  const updates = { ...input.updates, updatedAt: sql`now()` };
  const actor = { type: 'device' as const, id: input.deviceId };
  await executor.update(issues).set(updates).where(eq(issues.id, input.issueId));
  if (input.labelIds === undefined) return;

  const existing = await executor
    .select({ labelId: issueLabels.labelId })
    .from(issueLabels)
    .where(eq(issueLabels.issueId, input.issueId));
  const oldSet = new Set(existing.map((row) => row.labelId));
  const newSet = new Set(input.labelIds);
  const labelsAdded = [...newSet].filter((labelId) => !oldSet.has(labelId));
  const labelsRemoved = [...oldSet].filter((labelId) => !newSet.has(labelId));

  await executor.delete(issueLabels).where(eq(issueLabels.issueId, input.issueId));
  if (input.labelIds.length > 0) {
    await executor
      .insert(issueLabels)
      .values(input.labelIds.map((labelId) => ({ issueId: input.issueId, labelId })));
  }

  for (const labelId of labelsAdded) {
    await recordActivityTx(executor, {
      issueId: input.issueId,
      actor,
      action: 'issue.labeled',
      payload: { labelId },
    });
  }
  for (const labelId of labelsRemoved) {
    await recordActivityTx(executor, {
      issueId: input.issueId,
      actor,
      action: 'issue.unlabeled',
      payload: { labelId },
    });
  }
}
