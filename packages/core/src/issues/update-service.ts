import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, issues } from '../db/schema.js';
import { type Actor, recordActivityTx } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { CONTRACT_INPUT_FIELDS } from './entry-criteria-keys.js';
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

export async function updateIssueFields(input: IssueUpdateInput): Promise<IssueRow> {
  const row = await writeIssueFields(input);
  await announceContractInput(input.issueId, row.projectId, input.updates);
  return row;
}

async function writeIssueFields(input: IssueUpdateInput): Promise<IssueRow> {
  const { issueId, updates, labelIds, expect, actor } = input;
  const guard = expect ? [sessionContextGuard(expect.sessionContext)] : [];

  return db.transaction(async (tx) => {
    if (updates.sessionContext !== undefined && !expect) {
      await refuseUnreadSessionContextDrop(tx, issueId, updates.sessionContext);
    }
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

async function announceContractInput(
  issueId: string,
  projectId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const moved = CONTRACT_INPUT_FIELDS.filter((f) => f in updates);
  if (moved.length === 0) return;
  await hooks.emit('contractInputChanged', {
    projectId,
    issueId,
    reason: `fields written: ${moved.join(', ')}`,
  });
}

/**
 * A `sessionContext` write replaces the field whole, so one that omits a key the
 * field already holds destroys it — there is no history to read it back from.
 * A caller that sent `expect` read the current value and means the removal, so
 * it passes. One that did not is refused by name, naming the keys it would have
 * dropped, because the alternative is the write landing silently: a probe body
 * of `{ probe: 1 }` took `landing`, `lease` and `worklog` off ISS-1127 in one
 * call on 2026-09-21, and the landing checkpoint underneath was unrecoverable.
 */
async function refuseUnreadSessionContextDrop(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  issueId: string,
  next: unknown,
): Promise<void> {
  const [current] = await tx
    .select({ sessionContext: issues.sessionContext })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const held = current?.sessionContext;
  if (!held || typeof held !== 'object' || Array.isArray(held)) return;

  const kept = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
  const dropped = Object.keys(held).filter((k) => !(k in (kept as Record<string, unknown>)));
  if (dropped.length === 0) return;
  throw new SessionContextDropsUnreadKeys(dropped);
}

export class SessionContextDropsUnreadKeys extends Error {
  constructor(readonly dropped: string[]) {
    super('SESSION_CONTEXT_DROPS_UNREAD_KEYS');
    this.name = 'SessionContextDropsUnreadKeys';
  }
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
