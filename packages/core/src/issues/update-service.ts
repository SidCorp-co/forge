import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, issues } from '../db/schema.js';
import { type Actor, recordActivityTx } from '../pipeline/activity.js';
import type { ResolvedLabelAttach } from './label-service.js';
import type { IssueRow } from './read-service.js';
import type { SessionContextExpect } from './session-context.js';

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
  /**
   * ISS-959 — the `sessionContext` the caller read, sent back as the write's
   * precondition. `undefined` writes unconditionally, exactly as before.
   */
  expect?: SessionContextExpect | undefined;
  actor: Actor;
};

/**
 * The single field+label writer behind REST `PATCH /api/issues/:id` and MCP
 * `forge_issues.update`. Both previously carried their own copy of this
 * transaction and had already drifted: the MCP copy capped the existing-label
 * read at 500 rows, so an issue past that cap computed its delta against a
 * truncated `oldSet` and re-inserted labels it never removed.
 */
export async function updateIssueFields(input: IssueUpdateInput): Promise<IssueRow> {
  const { issueId, updates, labelIds, expect, actor } = input;
  const guard = expect ? [sessionContextGuard(expect.sessionContext)] : [];

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(issues)
      .set(updates)
      .where(and(eq(issues.id, issueId), ...guard))
      .returning();
    if (!row) {
      if (expect) await refuseMovedSessionContext(tx, issueId);
      throw new IssueUpdateNotFound(issueId);
    }

    if (labelIds !== undefined) {
      const existing = await tx
        .select({ labelId: issueLabels.labelId })
        .from(issueLabels)
        .where(eq(issueLabels.issueId, issueId));
      const oldSet = new Set(existing.map((r) => r.labelId));
      const newSet = new Set(labelIds.map((l) => l.labelId));

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

function sessionContextGuard(expected: Record<string, unknown> | null) {
  const expr = expected === null ? sql`null::jsonb` : sql`${JSON.stringify(expected)}::jsonb`;
  return sql`${issues.sessionContext} is not distinct from ${expr}`;
}

/**
 * Zero rows updated under a precondition means one of two things, and a caller
 * told the wrong one retries forever or gives up wrongly. Re-read inside the
 * doomed transaction: the row is gone, or the field moved — and when it moved,
 * hand back the value it moved TO, which is what the loser needs to rebase its
 * lease and try again.
 */
async function refuseMovedSessionContext(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  issueId: string,
): Promise<void> {
  const [current] = await tx
    .select({ sessionContext: issues.sessionContext })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!current) return;
  throw new SessionContextExpectMismatch(current.sessionContext ?? null);
}

/** The write carried an `expect` the field no longer holds. `current` is what it holds now. */
export class SessionContextExpectMismatch extends Error {
  constructor(readonly current: unknown) {
    super('SESSION_CONTEXT_MISMATCH');
    this.name = 'SessionContextExpectMismatch';
  }
}

export class IssueUpdateNotFound extends Error {
  constructor(readonly issueId: string) {
    super('ISSUE_NOT_FOUND');
    this.name = 'IssueUpdateNotFound';
  }
}
