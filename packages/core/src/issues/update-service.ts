import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, issues } from '../db/schema.js';
import { type Actor, recordActivityTx } from '../pipeline/activity.js';
import type { ResolvedLabelAttach } from './label-service.js';
import type { IssueRow } from './read-service.js';

export type IssueUpdateInput = {
  issueId: string;
  /** Plain column writes, already filtered through `collectIssueFieldUpdates`. */
  updates: Record<string, unknown>;
  /**
   * Replace-set. `undefined` leaves labels untouched; `[]` clears them. Resolved rows only —
   * run them through `label-service` BEFORE calling, so an unknown label or an illegal
   * primary fails outside the transaction rather than rolling one back.
   */
  labelIds?: ResolvedLabelAttach[] | undefined;
  actor: Actor;
};

/**
 * The single field+label writer behind REST `PATCH /api/issues/:id` and MCP
 * `forge_issues.update`. Both previously carried their own copy of this
 * transaction and had already drifted: the MCP copy capped the existing-label
 * read at 500 rows, so an issue past that cap computed its delta against a
 * truncated `oldSet` and re-inserted labels it never removed.
 */
// cm:guard the label delta and its activity rows commit in ONE transaction with the field update — a partial commit leaves `issue.labeled` claiming a label the issues row does not carry, and the activity feed is the only record of who changed a label
export async function updateIssueFields(input: IssueUpdateInput): Promise<IssueRow> {
  const { issueId, updates, labelIds, actor } = input;

  return db.transaction(async (tx) => {
    const [row] = await tx.update(issues).set(updates).where(eq(issues.id, issueId)).returning();
    if (!row) throw new IssueUpdateNotFound(issueId);

    if (labelIds !== undefined) {
      const existing = await tx
        .select({ labelId: issueLabels.labelId })
        .from(issueLabels)
        .where(eq(issueLabels.issueId, issueId));
      const oldSet = new Set(existing.map((r) => r.labelId));
      const newSet = new Set(labelIds.map((l) => l.labelId));

      // cm:guard the delete and the re-insert are what make a primary swap atomic — the old primary row is gone before the new one lands, so `issue_labels_primary_uq` never sees two true rows for the issue and no caller has to clear the old designation first.
      await tx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
      if (labelIds.length > 0) {
        await tx
          .insert(issueLabels)
          .values(labelIds.map((l) => ({ issueId, labelId: l.labelId, isPrimary: l.isPrimary })));
      }

      for (const labelId of [...newSet].filter((l) => !oldSet.has(l))) {
        await recordActivityTx(tx, {
          issueId,
          actor,
          action: 'issue.labeled',
          payload: { labelId },
        });
      }
      for (const labelId of [...oldSet].filter((l) => !newSet.has(l))) {
        await recordActivityTx(tx, {
          issueId,
          actor,
          action: 'issue.unlabeled',
          payload: { labelId },
        });
      }
    }

    return row;
  });
}

export class IssueUpdateNotFound extends Error {
  constructor(readonly issueId: string) {
    super('ISSUE_NOT_FOUND');
    this.name = 'IssueUpdateNotFound';
  }
}
